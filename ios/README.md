# Local AI for iPhone

Talk to a model on the phone itself, or to the models your own machines are running.

- **On this iPhone:** [LFM3-1.7B](https://huggingface.co/LiquidAI/LFM3-1.7B) by Liquid AI, run with llama.cpp on the phone's GPU. It is downloaded once (1.1 GB, Liquid's own `Q4_K_M` GGUF, pinned to one commit and checked against its SHA-256) and nothing you write to it leaves the phone. It needs an iPhone with 8 GB of memory: the iPhone 15 Pro and everything since. The app requires that tier (`iphone-performance-gaming-tier`), so it installs only where the model can run.
- **Your machines:** add a computer running Local AI by its address. On your own Tailscale it hands over its key by itself; otherwise type the key from Settings › API endpoints there. Its ready models, and those of the machines connected to it, appear in the model menu, and the phone talks to each model directly on its own port.

## Build

```
brew install xcodegen
cd ios
./fetch-llama.sh        # llama.cpp b12262 for iOS, checked against its hash, into Vendor/ (a build does this too)
xcodegen                # writes LocalAI.xcodeproj from project.yml
open LocalAI.xcodeproj
```

To run it on a phone, choose your team under Signing & Capabilities. LFM3 needs llama.cpp b11960 or newer; the pinned build is in `fetch-llama.sh`.

## Files

```
project.yml            the Xcode project, as text
fetch-llama.sh         fetches the pinned llama.cpp framework
LocalAI/
  LocalAIApp.swift     starts the app; asks your machines every few seconds what they are running
  Conversation.swift   one conversation with one model, here or on a machine
  Engine/
    OnDevice.swift     the phone's model: where it comes from, whether this phone can run it, its download
    LlamaEngine.swift  llama.cpp: load, read a prompt, write an answer piece by piece, stop
    ChatFormat.swift   how LFM3's conversations are written, and its reasoning told apart from its answer
  Remote/
    Machines.swift     your machines, their keys (in the Keychain), and the models ready on them
    RemoteChat.swift   a conversation with a model on a machine, over its OpenAI chat API
  Views/               the chat screen, Settings, the colours and the dove
LocalAIUITests/        walks the app in the Simulator
Tools/check-engine.sh  proves the on-device engine on a Mac with the real model
```

No answer is ever capped in length, here or on a machine: a model writes until it ends its turn, the conversation fills its window (8,192 tokens on the phone), or you press Stop.

## How it is checked

The llama.cpp framework has a slice for iPhones and one for Macs, and none for the Simulator. So the two halves are checked separately:

- `Tools/check-engine.sh /path/to/LFM3-1.7B-Q4_K_M.gguf` builds the same `LlamaEngine.swift` and `ChatFormat.swift` against the framework's macOS slice and runs the real model: it answers a question, reasons first, answers a follow-up from the conversation while reading only the new part, stops when cancelled, and starts over after a reset. 14 checks.
- `LocalAIUITests` runs the app in the Simulator against a real Local AI: no model at first, a wrong key refused, a machine added, its model chosen, a question and a follow-up answered, a new conversation, the machine removed.

```
TEST_RUNNER_LOCAL_AI_ADDRESS=127.0.0.1 TEST_RUNNER_LOCAL_AI_KEY=<key> \
  xcodebuild test -project LocalAI.xcodeproj -scheme LocalAI -destination 'platform=iOS Simulator,name=<a simulator>'
```

**Not yet checked: the app on an iPhone.** The iPhone build compiles and links llama.cpp, but it has not been run on a phone, so the download screen, loading the model on the phone's GPU, and speed and memory there are untested.

## Before the App Store

These need your Apple account, so they are not done:

1. Sign in to Xcode with the Apple ID of your developer team and set the team on the `LocalAI` target (or `DEVELOPMENT_TEAM` in `project.yml`).
2. Run it on an iPhone 15 Pro or newer: download the model, hold a conversation, watch memory in Xcode.
3. In App Store Connect, create the app with bundle id `ai.sybilsolutions.local.ios`.
4. Archive (Product › Archive) and upload.
5. For review: screenshots, a description, a privacy policy address (the app collects nothing; `PrivacyInfo.xcprivacy` says so), and a note for the reviewer on why plain HTTP is allowed (`NSAllowsArbitraryLoads`): the app talks to the user's own machines at addresses they type, on their own network or Tailscale, and those have no certificates.
6. Read the model's licence (LFM Open License v1.0, on its Hugging Face page) before shipping an app built around it.
