// Proves the on-device engine on a Mac, with the real model file, since the framework has no slice for the Simulator.
// It is the same LlamaEngine.swift and ChatFormat.swift the app uses, against the framework's macOS slice.
//
//   ios/Tools/check-engine.sh /path/to/LFM3-1.7B-Q4_K_M.gguf
//
// It checks how a conversation is written and read back, then asks the model three things: a fact, a follow-up that
// needs the first answer (so what the context holds is reused), and a longer answer that is cancelled part way.
import Foundation

var failed = 0
func check(_ name: String, _ ok: Bool, _ detail: String = "") {
    print("\(ok ? "ok  " : "FAIL") \(name)\(ok || detail.isEmpty ? "" : ": \(detail)")")
    if !ok { failed += 1 }
}
final class Collected: @unchecked Sendable { var text = "" }

// 1. The format, with no model.
let turns = [Turn(role: .system, text: "Be brief."), Turn(role: .user, text: "Hi"), Turn(role: .assistant, text: "I should greet.</think>Hello."), Turn(role: .user, text: "Bye")]
check("a conversation is written as LFM3's template writes it",
      ChatFormat.prompt(for: turns) == "<|im_start|>system\nBe brief.<|im_end|>\n<|im_start|>user\nHi<|im_end|>\n<|im_start|>assistant\n<think></think>Hello.<|im_end|>\n<|im_start|>user\nBye<|im_end|>\n<|im_start|>assistant\n<think>")
for pieces in [["I think.</think>", "\nParis"], ["I th", "ink.</th", "ink>\n\nPa", "ris"], ["I think.<", "/", "think", ">", "Paris"], ["I think.</think>Paris"]] {
    var split = ThinkSplitter()
    pieces.forEach { split.add($0) }
    split.finish()
    check("reasoning and answer are told apart however the pieces fall (\(pieces.count) pieces)", split.thinking == "I think." && split.answer == "Paris", "\(split.thinking)|\(split.answer)")
}
var open = ThinkSplitter()
["still thinking <", "/thi"].forEach { open.add($0) }
open.finish()
check("an answer that never leaves its reasoning keeps all of it as reasoning", open.thinking == "still thinking </thi" && open.answer.isEmpty)
var plain = ThinkSplitter(startsInside: false)
plain.add("Paris </think> is text here")
check("an engine that does not start inside its reasoning is read as answer only", plain.answer == "Paris </think> is text here" && plain.thinking.isEmpty)

// 2. The model.
guard CommandLine.arguments.count > 1 else { print("\nGive the path of the model file to check the engine too."); exit(failed == 0 ? 0 : 1) }
// The engine is let go of before the program ends: llama.cpp's Metal backend stops the program if it is still in use then.
do {
let engine = try LlamaEngine(path: CommandLine.arguments[1])
func ask(_ turns: [Turn]) async throws -> (thinking: String, answer: String, read: Int, written: Int, seconds: Double) {
    let got = Collected()
    let stats = try await engine.write(after: ChatFormat.prompt(for: turns)) { got.text += $0 }
    var split = ThinkSplitter()
    split.add(got.text)
    split.finish()
    return (split.thinking, split.answer, stats.read, stats.written, stats.seconds)
}

var talk = [Turn(role: .user, text: "What is the capital of France? Answer with the city's name only.")]
let first = try await ask(talk)
check("it answers a question", first.answer.contains("Paris"), first.answer)
check("it reasons before it answers, and the two are told apart", !first.thinking.isEmpty && !first.answer.contains("</think>"), "thinking \(first.thinking.count) characters")
print("     \(first.read) tokens read, \(first.written) written in \(String(format: "%.1f", first.seconds)) s (\(String(format: "%.0f", Double(first.written) / max(first.seconds, 0.001))) tokens/s)")

talk += [Turn(role: .assistant, text: first.thinking + "</think>" + first.answer), Turn(role: .user, text: "Which river runs through that city? Answer with the river's name only.")]
let second = try await ask(talk)
check("a follow-up is answered from the conversation so far", second.answer.contains("Seine"), second.answer)
check("only the new part of the conversation is read again", second.read < first.read + 60, "\(second.read) tokens read")

let long = Collected()
let writing = Task { try await engine.write(after: ChatFormat.prompt(for: [Turn(role: .user, text: "Write a 400-word story about a lighthouse.")])) { long.text += $0 } }
try await Task.sleep(for: .seconds(2))
writing.cancel()
let stopped = try await writing.value
check("an answer being written stops when it is cancelled", stopped.written > 5 && stopped.written < 2000, "\(stopped.written) tokens")

await engine.reset()
let again = try await ask([Turn(role: .user, text: "Reply with the single word: pong")])
check("after a reset it starts a new conversation", again.answer.lowercased().contains("pong"), again.answer)
}

print(failed == 0 ? "\nall checks passed" : "\n\(failed) check(s) failed")
exit(failed == 0 ? 0 : 1)
