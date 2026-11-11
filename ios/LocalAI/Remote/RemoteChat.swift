// A conversation with a model on one of your machines, over the OpenAI chat API it serves.
import Foundation

enum RemoteChat {
    enum Piece { case thinking(String), answer(String) }

    private struct Chunk: Decodable {
        struct Choice: Decodable {
            struct Delta: Decodable {
                var content: String?
                var reasoning_content: String?
                var reasoning: String?
            }
            var delta: Delta?
        }
        var choices: [Choice]?
    }
    private struct Failure: Decodable {
        struct Detail: Decodable { var message: String? }
        var error: Detail?
        var message: String?
    }

    /// Asks for the next answer and passes it on as it is written. No limit is put on its length.
    /// Cancelling the task closes the connection, which stops the engine writing.
    static func write(after turns: [Turn], on model: RemoteModel, piece: @escaping @Sendable (Piece) -> Void) async throws {
        var request = URLRequest(url: model.base.appending(path: "chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = 600
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer local", forHTTPHeaderField: "Authorization")
        let messages = turns.map { ["role": $0.role.rawValue, "content": $0.role == .assistant ? ChatFormat.answer(in: $0.text) : $0.text] }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model.model, "messages": messages, "stream": true] as [String: Any])
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            var body = Data()
            for try await byte in bytes.prefix(4000) { body.append(byte) }
            let said = (try? JSONDecoder().decode(Failure.self, from: body)).flatMap { $0.error?.message ?? $0.message }
            throw NSError(domain: "LocalAI", code: status, userInfo: [NSLocalizedDescriptionKey: said ?? "\(model.machine) answered \(status)"])
        }
        for try await line in bytes.lines {
            guard line.hasPrefix("data:") else { continue }
            let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            if payload == "[DONE]" { break }
            guard let delta = (try? JSONDecoder().decode(Chunk.self, from: Data(payload.utf8)))?.choices?.first?.delta else { continue }
            if let thought = delta.reasoning_content ?? delta.reasoning, !thought.isEmpty { piece(.thinking(thought)) }
            if let text = delta.content, !text.isEmpty { piece(.answer(text)) }
        }
    }
}
