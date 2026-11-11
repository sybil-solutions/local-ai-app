// LFM3 running on this device, through llama.cpp. One model, one conversation at a time.
//
// The framework has no slice for the Simulator, so there this file compiles to nothing and the app offers only the
// models on your machines (see OnDevice.swift).
#if canImport(llama)
import Foundation
import llama

enum EngineError: LocalizedError {
    case cannotLoad, cannotStart, tooLong, failed(Int32)
    var errorDescription: String? {
        switch self {
        case .cannotLoad: "The model file could not be loaded"
        case .cannotStart: "There is not enough free memory to start the model"
        case .tooLong: "This conversation is longer than the model can hold. Start a new one"
        case .failed(let code): "The model stopped (\(code))"
        }
    }
}

actor LlamaEngine {
    private let model: OpaquePointer
    private let context: OpaquePointer
    private let vocab: OpaquePointer
    private let sampler: UnsafeMutablePointer<llama_sampler>
    private let window: Int
    private let batch: Int
    /// The tokens the context already holds, so a follow-up question only computes what is new.
    private var held: [llama_token] = []

    /// `contextLength` is how many tokens a conversation may hold. `onGPU` is false where there is no Metal.
    init(path: String, contextLength: Int = 8192, onGPU: Bool = true) throws {
        llama_log_set({ _, _, _ in }, nil) // llama.cpp writes a line for everything it does; none of it is for the person using the app
        llama_backend_init()
        var modelParams = llama_model_default_params()
        modelParams.n_gpu_layers = onGPU ? 999 : 0
        guard let model = llama_model_load_from_file(path, modelParams) else { throw EngineError.cannotLoad }
        var params = llama_context_default_params()
        params.n_ctx = UInt32(min(contextLength, Int(llama_model_n_ctx_train(model))))
        params.n_batch = 512
        // Leave two cores for the app and the system; the efficiency cores slow generation down more than they help.
        let threads = Int32(max(1, min(6, ProcessInfo.processInfo.activeProcessorCount - 2)))
        params.n_threads = threads
        params.n_threads_batch = threads
        guard let context = llama_init_from_model(model, params) else { llama_model_free(model); throw EngineError.cannotStart }
        self.model = model
        self.context = context
        vocab = llama_model_get_vocab(model)
        window = Int(llama_n_ctx(context))
        batch = Int(params.n_batch)
        // The sampling Liquid recommends for LFM3: temperature 0.1, top-k 50, repeat penalty 1.1.
        sampler = llama_sampler_chain_init(llama_sampler_chain_default_params())
        llama_sampler_chain_add(sampler, llama_sampler_init_penalties(llama_vocab_n_tokens(vocab), 64, 1.1, 0, 0))
        llama_sampler_chain_add(sampler, llama_sampler_init_top_k(50))
        llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.1))
        llama_sampler_chain_add(sampler, llama_sampler_init_dist(UInt32.random(in: 0 ..< .max)))
    }

    deinit {
        llama_sampler_free(sampler)
        llama_free(context)
        llama_model_free(model)
    }

    /// Writes the answer to `prompt`, a piece at a time, until the model ends its turn, the conversation fills the
    /// window, or the task is cancelled. There is no cap on the length of an answer.
    /// Returns how many tokens it read and wrote and how long the writing took.
    @discardableResult
    func write(after prompt: String, piece: @Sendable (String) -> Void) throws -> (read: Int, written: Int, seconds: Double) {
        let tokens = tokenize(prompt)
        guard tokens.count < window - 16 else { throw EngineError.tooLong }
        try keepCommonStart(with: tokens)
        let fresh = Array(tokens[held.count...])
        for start in stride(from: 0, to: fresh.count, by: batch) {
            if Task.isCancelled { return (fresh.count, 0, 0) }
            try decode(Array(fresh[start ..< min(start + batch, fresh.count)]))
        }
        var bytes: [UInt8] = [], written = 0
        let began = Date()
        while !Task.isCancelled, held.count < window {
            let token = llama_sampler_sample(sampler, context, -1)
            if llama_vocab_is_eog(vocab, token) { break }
            bytes += text(of: token)
            // A character can arrive split across tokens; only whole characters are passed on.
            if let whole = String(validatingUTF8: bytes.map { CChar(bitPattern: $0) } + [0]) { piece(whole); bytes = [] }
            try decode([token])
            written += 1
        }
        if !bytes.isEmpty { piece(String(decoding: bytes, as: UTF8.self)) }
        return (fresh.count, written, Date().timeIntervalSince(began))
    }

    /// Forgets the conversation, so the next prompt is read from its start.
    func reset() {
        llama_memory_clear(llama_get_memory(context), true)
        held = []
    }

    // Keeps what the context already holds of this prompt and drops the rest. Some models can't drop a part of what
    // they hold; then everything is dropped and the whole prompt is read again.
    private func keepCommonStart(with tokens: [llama_token]) throws {
        var same = 0
        while same < held.count, same < tokens.count, held[same] == tokens[same] { same += 1 }
        if same == tokens.count { same -= 1 } // at least one token has to be computed, to have something to sample from
        guard same < held.count else { return }
        if same > 0, llama_memory_seq_rm(llama_get_memory(context), 0, llama_pos(same), -1) { held.removeLast(held.count - same) } else { reset() }
    }

    private func decode(_ tokens: [llama_token]) throws {
        var tokens = tokens
        let status = tokens.withUnsafeMutableBufferPointer { llama_decode(context, llama_batch_get_one($0.baseAddress, Int32($0.count))) }
        guard status == 0 else { throw status == 1 ? EngineError.tooLong : EngineError.failed(status) }
        held += tokens
    }

    private func tokenize(_ text: String) -> [llama_token] {
        let utf8 = Array(text.utf8CString.dropLast())
        var tokens = [llama_token](repeating: 0, count: utf8.count + 8)
        let count = llama_tokenize(vocab, utf8, Int32(utf8.count), &tokens, Int32(tokens.count), true, true)
        return Array(tokens.prefix(Int(max(0, count))))
    }

    private func text(of token: llama_token) -> [UInt8] {
        var buffer = [CChar](repeating: 0, count: 64)
        var length = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        if length < 0 { // the piece is longer than the buffer: the answer says by how much
            buffer = [CChar](repeating: 0, count: Int(-length))
            length = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        }
        return buffer.prefix(Int(max(0, length))).map { UInt8(bitPattern: $0) }
    }
}
#endif
