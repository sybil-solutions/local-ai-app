// Settings: the model on this iPhone, and your machines.
import SwiftUI

struct SettingsScreen: View {
    @Environment(ModelFile.self) private var file
    @Environment(Machines.self) private var machines
    @Environment(Conversation.self) private var talk
    @Environment(\.dismiss) private var dismiss
    @State private var adding = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    onDevice
                } header: { Text("On this iPhone") } footer: {
                    Text("\(OnDeviceModel.name) by Liquid AI runs entirely on the phone. Nothing you write to it leaves the phone. It is downloaded once from Hugging Face.")
                }
                Section {
                    ForEach(machines.list) { machine in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(machine.name)
                            Text(machines.problems[machine.id] ?? summary(of: machine)).font(.footnote).foregroundStyle(machines.problems[machine.id] == nil ? Ink.muted : Ink.stop)
                        }
                    }
                    .onDelete { rows in rows.map { machines.list[$0] }.forEach(machines.remove) }
                    Button("Add a machine", systemImage: "plus") { adding = true }
                } header: { Text("Your machines") } footer: {
                    Text("A computer running Local AI, reached over your own network or Tailscale. Its models, and those of the machines connected to it, appear in the model menu.")
                }
                Section("About") {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                    Link("About \(OnDeviceModel.name)", destination: OnDeviceModel.page)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ink.ground)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $adding) { AddMachine() }
            .task { await machines.refresh() }
        }
        .preferredColorScheme(.dark)
    }

    private func summary(of machine: Machine) -> String {
        let count = machines.models.filter { $0.base.host == machine.address.host || machines.list.count == 1 }.count
        return count == 0 ? "No model running" : count == 1 ? "1 model ready" : "\(count) models ready"
    }

    @ViewBuilder private var onDevice: some View {
        let size = ByteCountFormatter.string(fromByteCount: OnDeviceModel.bytes, countStyle: .file)
        if !OnDeviceModel.canRun {
            row(OnDeviceModel.name, "Runs on an iPhone, not in the Simulator")
        } else if !OnDeviceModel.fits {
            row(OnDeviceModel.name, "Needs an iPhone with 8 GB of memory")
        } else {
            switch file.state {
            case .missing:
                HStack { row(OnDeviceModel.name, "\(size) to download"); Spacer(); Button("Download") { file.download() }.buttonStyle(.borderedProminent).tint(Ink.text).foregroundStyle(Ink.ground) }
            case .downloading(let done):
                VStack(alignment: .leading, spacing: 8) {
                    HStack { row(OnDeviceModel.name, "\(Int(done * 100))% of \(size)"); Spacer(); Button("Cancel") { file.cancel() } }
                    ProgressView(value: done)
                }
            case .checking:
                HStack { row(OnDeviceModel.name, "Checking the download"); Spacer(); ProgressView() }
            case .ready:
                HStack { row(OnDeviceModel.name, "Ready · \(size)"); Spacer(); Button("Delete", role: .destructive) { talk.unload(); file.delete() }.disabled(talk.writing) }
            case .failed(let why):
                VStack(alignment: .leading, spacing: 8) {
                    row(OnDeviceModel.name, why)
                    Button("Try again") { file.download() }
                }
            }
        }
    }

    private func row(_ name: String, _ line: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
            Text(line).font(.footnote).foregroundStyle(Ink.muted)
        }
    }
}

private struct AddMachine: View {
    @Environment(Machines.self) private var machines
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var key = ""
    @State private var problem: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("100.90.62.80 or my-mac", text: $address)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("Key (not needed on your Tailscale)", text: $key)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Address") } footer: {
                    Text(problem ?? "The address of a computer running Local AI. On your own Tailscale it hands over its key by itself; otherwise the key is under Settings › API endpoints in Local AI on that computer.")
                        .foregroundStyle(problem == nil ? Ink.muted : Ink.stop)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Ink.ground)
            .navigationTitle("Add a machine")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working { ProgressView() } else { Button("Add") { add() }.disabled(address.trimmingCharacters(in: .whitespaces).isEmpty) }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func add() {
        working = true
        problem = nil
        Task {
            do { try await machines.add(address: address, key: key); dismiss() } catch { problem = error.localizedDescription }
            working = false
        }
    }
}
