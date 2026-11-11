// The one screen: the conversation, the model it is with, and where you type.
import SwiftUI

struct ChatScreen: View {
    @Environment(ModelFile.self) private var file
    @Environment(Machines.self) private var machines
    @Environment(Conversation.self) private var talk
    @State private var draft = ""
    @State private var settings = false
    @FocusState private var typing: Bool

    private var phoneReady: Bool { OnDeviceModel.canRun && OnDeviceModel.fits && file.state == .ready }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if talk.messages.isEmpty { Welcome(openSettings: { settings = true }) } else { messages }
                if let problem = talk.problem { Problem(text: problem) }
                composer
            }
            .background(Ink.ground)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { modelMenu }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("New conversation", systemImage: "square.and.pencil") { talk.clear() }.disabled(talk.messages.isEmpty)
                    Button("Settings", systemImage: "gearshape") { settings = true }
                }
            }
            .toolbarBackground(Ink.ground, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $settings) { SettingsScreen() }
        }
    }

    private var modelMenu: some View {
        Menu {
            Section("On this iPhone") {
                if phoneReady {
                    choose(.phone, title: OnDeviceModel.name)
                } else {
                    Button(OnDeviceModel.canRun && OnDeviceModel.fits ? "Get \(OnDeviceModel.name)" : "\(OnDeviceModel.name) can’t run here", systemImage: "arrow.down.circle") { settings = true }
                }
            }
            ForEach(Dictionary(grouping: machines.models, by: \.machine).sorted { $0.key < $1.key }, id: \.key) { machine, models in
                Section(machine) { ForEach(models) { choose(.machine($0), title: $0.title) } }
            }
            if machines.list.isEmpty { Button("Add a machine", systemImage: "plus") { settings = true } }
        } label: {
            HStack(spacing: 6) {
                Dove().fill(Ink.text).frame(width: 15, height: 20)
                VStack(alignment: .leading, spacing: 0) {
                    Text(talk.choice?.title ?? "Local AI").font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let place = talk.choice?.place { Text(place).font(.caption2).foregroundStyle(Ink.muted).lineLimit(1) }
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Ink.muted)
            }
            .foregroundStyle(Ink.text)
        }
        .disabled(talk.writing)
        .accessibilityLabel("Model: \(talk.choice?.title ?? "none chosen")")
    }

    private func choose(_ choice: Choice, title: String) -> some View {
        Button { talk.choice = choice } label: { if talk.choice == choice { Label(title, systemImage: "checkmark") } else { Text(title) } }
    }

    private var messages: some View {
        ScrollViewReader { scroll in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(talk.messages) { Bubble(message: $0, live: talk.writing && $0.id == talk.messages.last?.id, loading: talk.loading) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: talk.messages.last?.text) { scroll.scrollTo("end", anchor: .bottom) }
            .onChange(of: talk.messages.last?.thinking) { scroll.scrollTo("end", anchor: .bottom) }
            .onChange(of: talk.messages.count) { withAnimation { scroll.scrollTo("end", anchor: .bottom) } }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField(talk.choice == nil ? "Choose a model first" : "Message", text: $draft, axis: .vertical)
                .lineLimit(1 ... 6)
                .focused($typing)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Ink.surface, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Ink.line))
                .disabled(talk.choice == nil)
            Button {
                if talk.writing { talk.stop() } else { talk.send(draft); draft = "" }
            } label: {
                Image(systemName: talk.writing ? "stop.fill" : "arrow.up")
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .background(talk.writing ? Ink.stop : (canSend ? Ink.text : Ink.surface), in: Circle())
                    .foregroundStyle(talk.writing ? .white : (canSend ? Ink.ground : Ink.muted))
            }
            .disabled(!talk.writing && !canSend)
            .accessibilityLabel(talk.writing ? "Stop" : "Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Ink.ground)
    }

    private var canSend: Bool { talk.choice != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

/// What is shown before the first message: what the app is, and what to do when there is no model to talk to yet.
private struct Welcome: View {
    @Environment(ModelFile.self) private var file
    @Environment(Machines.self) private var machines
    @Environment(Conversation.self) private var talk
    var openSettings: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            Dove().fill(Ink.text.opacity(talk.choice == nil ? 0.35 : 0.9)).frame(width: 76, height: 100)
            if let choice = talk.choice {
                Text(choice.title).font(.title2.weight(.semibold))
                Text(choice.place).font(.subheadline).foregroundStyle(Ink.muted)
            } else {
                Text("No model yet").font(.title2.weight(.semibold))
                Text(hint).font(.subheadline).foregroundStyle(Ink.muted).multilineTextAlignment(.center).padding(.horizontal, 36)
                Button("Open Settings", action: openSettings)
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 22).padding(.vertical, 11)
                    .background(Ink.text, in: Capsule())
                    .foregroundStyle(Ink.ground)
                    .padding(.top, 6)
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var hint: String {
        let here = OnDeviceModel.canRun && OnDeviceModel.fits
        if machines.list.isEmpty { return here ? "Download \(OnDeviceModel.name) to talk to a model on this iPhone, or add one of your machines running Local AI." : "Add one of your machines running Local AI to talk to its models." }
        return "None of your machines is running a model right now." + (here ? " You can also download \(OnDeviceModel.name) to this iPhone." : "")
    }
}

private struct Bubble: View {
    var message: Message
    var live: Bool
    var loading: Bool
    @State private var showThinking = false

    var body: some View {
        if message.role == .user {
            Text(message.text)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Ink.surface, in: RoundedRectangle(cornerRadius: 18))
                .frame(maxWidth: .infinity, alignment: .trailing)
                .textSelection(.enabled)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if !message.thinking.isEmpty {
                    Button { showThinking.toggle() } label: {
                        Label(live && message.text.isEmpty ? "Thinking" : "Thought it through", systemImage: showThinking ? "chevron.down" : "chevron.right")
                            .font(.footnote).foregroundStyle(Ink.muted)
                    }
                    if showThinking {
                        Text(message.thinking).font(.footnote).foregroundStyle(Ink.muted)
                            .padding(.leading, 10)
                            .overlay(alignment: .leading) { Rectangle().fill(Ink.line).frame(width: 2) }
                            .textSelection(.enabled)
                    }
                }
                if !message.text.isEmpty {
                    Text(Self.styled(message.text)).textSelection(.enabled)
                } else if live {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        if loading { Text("Loading the model").font(.footnote).foregroundStyle(Ink.muted) }
                    }
                }
                if let note = message.note, !live { Text(note).font(.caption2).foregroundStyle(Ink.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Bold, italics, code and links in an answer are shown as such; the text is otherwise left exactly as written.
    private static func styled(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

private struct Problem: View {
    var text: String
    var body: some View {
        Text(text)
            .font(.footnote)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Ink.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Ink.stop.opacity(0.6)))
            .padding(.horizontal, 12).padding(.bottom, 4)
    }
}
