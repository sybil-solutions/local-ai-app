// Your computers running Local AI, and the models ready on them.
//
// A machine is its address and its key. Each answers GET /api/state with what it is running, and with the same for
// the machines connected to it, so adding one machine can bring the models of several. The models themselves are
// OpenAI-style servers on their own ports, with no key.
import Foundation
import Observation
import Security

struct Machine: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var address: URL
}

/// A model that is ready on one of your machines.
struct RemoteModel: Identifiable, Hashable {
    var id: String { "\(base.absoluteString) \(model)" }
    var title: String      // "glm-5.3-flash"
    var machine: String    // "workstation"
    var base: URL          // http://100.64.0.10:8000/v1
    var model: String      // the name the engine serves it under
    var context: Int
}

enum MachineError: LocalizedError {
    case badAddress, needsKey, wrongKey, answered(Int), notLocalAI
    var errorDescription: String? {
        switch self {
        case .badAddress: "Enter an address such as 100.64.0.10 or my-mac"
        case .needsKey: "That machine needs its key. It is under Settings › API endpoints in Local AI there"
        case .wrongKey: "That key is wrong"
        case .answered(let status): "It answered \(status)"
        case .notLocalAI: "That address did not answer as Local AI"
        }
    }
}

/// What a machine says about itself. Only what the app reads is decoded, and anything missing is left out.
private struct Snapshot: Decodable {
    struct Run: Decodable {
        var id: Int
        var name: String
        var phase: String
        var served: String?
        var ctx: Int?
        var reachable: Bool?
        var apis: [String]?
    }
    struct Device: Decodable {
        struct State: Decodable { var runs: [Run]? }
        var name: String
        var url: String
        var online: Bool?
        var state: State?
    }
    var name: String
    var runs: [Run]
    var devices: [Device]?
}

@MainActor @Observable
final class Machines {
    private(set) var list: [Machine] = []
    private(set) var models: [RemoteModel] = []
    /// Why a machine could not be read, by its id. A machine that answered is not in here.
    private(set) var problems: [UUID: String] = [:]

    private static let saved = "machines"
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    init() {
        if let data = UserDefaults.standard.data(forKey: Self.saved), let found = try? JSONDecoder().decode([Machine].self, from: data) { list = found }
    }

    /// Adds a machine. One of your own Tailscale machines hands over its key when asked; anything else needs it typed.
    func add(address typed: String, key typedKey: String) async throws {
        guard let address = Self.address(from: typed) else { throw MachineError.badAddress }
        var key = typedKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if key.isEmpty {
            var ask = URLRequest(url: address.appending(path: "api/pair"))
            ask.httpMethod = "POST"
            if let (data, response) = try? await Self.session.data(for: ask), (response as? HTTPURLResponse)?.statusCode == 200,
               let paired = try? JSONDecoder().decode([String: String].self, from: data), let given = paired["key"] { key = given }
        }
        guard !key.isEmpty else { throw MachineError.needsKey }
        let snapshot = try await Self.snapshot(of: address, key: key)
        var machine = Machine(name: snapshot.name, address: address)
        if let known = list.firstIndex(where: { $0.address == address }) { machine.id = list[known].id; list[known] = machine } else { list.append(machine) }
        Keychain.save(key, for: machine.id)
        save()
        await refresh()
    }

    func remove(_ machine: Machine) {
        list.removeAll { $0.id == machine.id }
        Keychain.remove(for: machine.id)
        problems[machine.id] = nil
        save()
        models.removeAll { $0.machine == machine.name }
    }

    /// Asks every machine what it is running. A machine that does not answer keeps its place in the list, with why.
    func refresh() async {
        var found: [RemoteModel] = [], failed: [UUID: String] = [:]
        await withTaskGroup(of: (UUID, Result<[RemoteModel], Error>).self) { group in
            for machine in list {
                let key = Keychain.key(for: machine.id) ?? ""
                group.addTask { (machine.id, await Result { try await Self.models(on: machine, key: key) }) }
            }
            for await (id, result) in group {
                switch result {
                case .success(let models): found += models
                case .failure(let error): failed[id] = error.localizedDescription
                }
            }
        }
        // The same model can be reached through two machines that are connected to each other: it is listed once.
        var seen = Set<String>()
        models = found.filter { seen.insert($0.id).inserted }.sorted { ($0.machine, $0.title) < ($1.machine, $1.title) }
        problems = failed
    }

    private func save() { UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: Self.saved) }

    /// "100.64.0.10", "my-mac:18700" and "http://my-mac" are all the same kind of address: http, port 18700 unless given.
    static func address(from typed: String) -> URL? {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") { text = "http://" + text }
        guard var parts = URLComponents(string: text), let host = parts.host, !host.isEmpty, ["http", "https"].contains(parts.scheme) else { return nil }
        if parts.port == nil { parts.port = 18700 }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }

    private nonisolated static func snapshot(of address: URL, key: String) async throws -> Snapshot {
        var request = URLRequest(url: address.appending(path: "api/state").appending(queryItems: [URLQueryItem(name: "v", value: "-1")]))
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status != 401 else { throw MachineError.wrongKey }
        guard status == 200 else { throw MachineError.answered(status) }
        guard let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { throw MachineError.notLocalAI }
        return snapshot
    }

    private nonisolated static func models(on machine: Machine, key: String) async throws -> [RemoteModel] {
        let snapshot = try await snapshot(of: machine.address, key: key)
        // A model is called on its own port, at the address of the machine it runs on.
        func ready(_ runs: [Snapshot.Run], on name: String, host: String?) -> [RemoteModel] {
            guard let host else { return [] }
            return runs.filter { $0.phase == "ready" && $0.reachable != false && ($0.apis?.contains("chat") ?? true) }.compactMap { run in
                var parts = URLComponents()
                parts.scheme = "http"
                parts.host = host
                parts.port = run.id
                parts.path = "/v1"
                return parts.url.map { RemoteModel(title: run.name, machine: name, base: $0, model: run.served ?? run.name, context: run.ctx ?? 0) }
            }
        }
        let own = ready(snapshot.runs, on: snapshot.name, host: machine.address.host)
        let beyond = (snapshot.devices ?? []).filter { $0.online != false }.flatMap { ready($0.state?.runs ?? [], on: $0.name, host: URL(string: $0.url)?.host) }
        return own + beyond
    }
}

private extension Result where Failure == Error {
    init(_ work: () async throws -> Success) async {
        do { self = .success(try await work()) } catch { self = .failure(error) }
    }
}

/// A machine's key, kept in the Keychain and not with the rest of the app's settings.
enum Keychain {
    private static func query(_ id: UUID) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "local-ai.machine-key", kSecAttrAccount as String: id.uuidString]
    }
    static func save(_ key: String, for id: UUID) {
        remove(for: id)
        var item = query(id)
        item[kSecValueData as String] = Data(key.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
    static func key(for id: UUID) -> String? {
        var item = query(id)
        item[kSecReturnData as String] = true
        var found: AnyObject?
        guard SecItemCopyMatching(item as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
    static func remove(for id: UUID) { SecItemDelete(query(id) as CFDictionary) }
}
