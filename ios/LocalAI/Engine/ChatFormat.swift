// How a conversation is written for LFM3, and how what it writes back is read.
//
// LFM3 uses ChatML turns. Its template starts every answer inside <think>, so the model first reasons and then
// closes the tag and answers. Earlier answers are sent back without their reasoning, as the template does.
import Foundation

struct Turn: Equatable, Sendable {
    enum Role: String, Sendable { case system, user, assistant }
    var role: Role
    var text: String
}

enum ChatFormat {
    /// The prompt for the next answer. The beginning-of-text token is added when it is tokenized.
    static func prompt(for turns: [Turn]) -> String {
        var out = ""
        for turn in turns where !turn.text.isEmpty || turn.role != .system {
            let body = turn.role == .assistant ? "<think></think>" + answer(in: turn.text) : turn.text
            out += "<|im_start|>\(turn.role.rawValue)\n\(body)<|im_end|>\n"
        }
        return out + "<|im_start|>assistant\n<think>"
    }

    /// What is left of an answer once its reasoning is taken out.
    static func answer(in text: String) -> String {
        guard let close = text.range(of: "</think>", options: .backwards) else { return text }
        return String(text[close.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Splits what the model writes, as it arrives, into its reasoning and its answer. The text starts inside the
/// reasoning; everything after the first </think> is the answer. A closing tag split across two pieces is held back
/// until it is whole.
struct ThinkSplitter {
    private(set) var thinking = ""
    private(set) var answer = ""
    private var pending = ""
    private var closed: Bool
    private static let close = "</think>"

    /// `startsInside` is false for an engine that sends its reasoning separately, or does not reason.
    init(startsInside: Bool = true) { closed = !startsInside }

    mutating func add(_ piece: String) {
        guard !closed else { answer += answer.isEmpty ? String(piece.drop(while: \.isNewline)) : piece; return } // the answer starts at its first word
        pending += piece
        if let at = pending.range(of: Self.close) {
            thinking += pending[..<at.lowerBound]
            let rest = String(pending[at.upperBound...])
            pending = ""
            closed = true
            add(rest)
            return
        }
        // Keep back only what could still be the start of the closing tag.
        var keep = 0
        for n in stride(from: min(Self.close.count - 1, pending.count), to: 0, by: -1) where Self.close.hasPrefix(pending.suffix(n)) { keep = n; break }
        thinking += pending.dropLast(keep)
        pending = String(pending.suffix(keep))
    }

    /// Called when the model stops: a held-back piece that never became a tag is reasoning after all.
    mutating func finish() {
        if !closed { thinking += pending }
        pending = ""
    }
}
