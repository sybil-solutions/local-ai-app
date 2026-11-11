// One conversation with one model: the one on this iPhone, or one on a machine of yours.
import Foundation
import Observation

struct Message: Identifiable, Equatable {
    let id = UUID()
    var role: Turn.Role
    var text: String
    /// What the model reasoned before it answered.
    var thinking = ""
    /// A line under a finished answer: how much was written, how fast.
    var note: String?
}

enum Choice: Hashable {
    case phone
    case machine(RemoteModel)

    var title: String {
        switch self {
        case .phone: OnDeviceModel.name
        case .machine(let model): model.title
        }
    }
    var place: String {
        switch self {
        case .phone: "On this iPhone"
        case .machine(let model): model.machine
        }
    }
}

@MainActor @Observable
final class Conversation {
    private(set) var messages: [Message] = []
    var choice: Choice? { didSet { if choice != oldValue { UserDefaults.standard.set(choice.map(Self.name), forKey: "choice") } } }
    /// True from Send until the answer ends or is stopped.
    private(set) var writing = false
    /// True while the model on this iPhone is being read into memory, which takes a few seconds the first time.
    private(set) var loading = false
    var problem: String?

    @ObservationIgnored private var task: Task<Void, Never>?
    #if canImport(llama)
    @ObservationIgnored private var engine: LlamaEngine?
    #endif

    private static func name(_ choice: Choice) -> String {
        switch choice {
        case .phone: "phone"
        case .machine(let model): model.id
        }
    }

    /// Chooses a model when none is chosen, or the chosen one is gone: the one used last, else the one on this
    /// iPhone, else the first on your machines.
    func settle(phoneReady: Bool, machines: [RemoteModel]) {
        let available = (phoneReady ? [Choice.phone] : []) + machines.map(Choice.machine)
        if let choice, available.contains(choice) || writing { return }
        let last = UserDefaults.standard.string(forKey: "choice")
        choice = available.first { Self.name($0) == last } ?? available.first
    }

    func send(_ text: String) {
        let asked = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !asked.isEmpty, !writing, let choice else { return }
        problem = nil
        messages.append(Message(role: .user, text: asked))
        let turns = messages.map { Turn(role: $0.role, text: $0.text) }
        messages.append(Message(role: .assistant, text: ""))
        let at = messages.count - 1
        writing = true
        task = Task {
            do {
                switch choice {
                case .phone: try await writeHere(turns, into: at)
                case .machine(let model): try await writeThere(turns, on: model, into: at)
                }
            } catch is CancellationError {
            } catch let error as URLError where error.code == .cancelled {
            } catch { problem = error.localizedDescription }
            if at < messages.count, messages[at].text.isEmpty, messages[at].thinking.isEmpty { messages.remove(at: at) } // nothing was written
            loading = false
            writing = false
        }
    }

    func stop() { task?.cancel() }

    func clear() {
        stop()
        messages = []
        problem = nil
        #if canImport(llama)
        if let engine { Task { await engine.reset() } }
        #endif
    }

    /// Lets go of the model on this iPhone, to give its memory back. It is read in again when next used.
    func unload() {
        #if canImport(llama)
        if !writing { engine = nil }
        #endif
    }

    private func writeHere(_ turns: [Turn], into at: Int) async throws {
        #if canImport(llama)
        if engine == nil {
            loading = true
            // Reading the model in is seconds of work, so it is done off the main thread.
            engine = try await Task.detached(priority: .userInitiated) { try LlamaEngine(path: OnDeviceModel.place.path) }.value
            loading = false
        }
        guard let engine else { return }
        let (pieces, feed) = AsyncStream<String>.makeStream()
        let prompt = ChatFormat.prompt(for: turns)
        async let done = { defer { feed.finish() }; return try await engine.write(after: prompt) { feed.yield($0) } }()
        var split = ThinkSplitter()
        for await piece in pieces {
            split.add(piece)
            messages[at].thinking = split.thinking
            messages[at].text = split.answer
        }
        split.finish()
        messages[at].thinking = split.thinking
        messages[at].text = split.answer
        let stats = try await done
        if stats.written > 0, stats.seconds > 0 { messages[at].note = "\(stats.written) tokens · \(Int((Double(stats.written) / stats.seconds).rounded())) tokens/s" }
        #else
        throw NSError(domain: "LocalAI", code: 1, userInfo: [NSLocalizedDescriptionKey: "The model on this iPhone can’t run in the Simulator"])
        #endif
    }

    private func writeThere(_ turns: [Turn], on model: RemoteModel, into at: Int) async throws {
        let (pieces, feed) = AsyncStream<RemoteChat.Piece>.makeStream()
        async let done: Void = { defer { feed.finish() }; try await RemoteChat.write(after: turns, on: model) { feed.yield($0) } }()
        let began = Date()
        var count = 0
        for await piece in pieces {
            count += 1
            switch piece {
            case .thinking(let text): messages[at].thinking += text
            case .answer(let text): messages[at].text += text
            }
        }
        try await done
        if count > 0 { messages[at].note = "\(model.machine) · \(String(format: "%.1f", Date().timeIntervalSince(began))) s" }
    }
}
