import SwiftUI
import NexusCore

private let maskedSentinel = "••••••••"

@MainActor
@Observable
final class SettingsViewModel {
    private var api: APIClient
    var working: JSONValue = .null
    private var original: JSONValue = .null
    var loadState: LoadState<Void> = .idle
    var saving = false
    var saveError: String?

    init(api: APIClient) { self.api = api }

    var dirty: Bool { working != original }

    func load() async {
        if case .loaded = loadState {} else { loadState = .loading }
        do {
            let config = try await api.settings()
            working = config
            original = config
            loadState = .loaded(())
            await maybeAutoToggle()
        } catch {
            loadState = .failed(LoadState<Void>.message(for: error))
        }
    }

    private func maybeAutoToggle() async {
        #if DEBUG
        // Verification hook: NEXUS_DEV_SETTINGS_TOGGLE="docker.enabled" flips a
        // boolean leaf and saves, exercising the strip → encode → PUT round-trip.
        guard let path = ProcessInfo.processInfo.environment["NEXUS_DEV_SETTINGS_TOGGLE"] else { return }
        let components = path.split(separator: ".").map(String.init)
        let current = working.value(at: components)?.bool ?? false
        working = working.setting(components, to: .bool(!current))
        await save()
        #endif
    }

    func save() async {
        saving = true
        defer { saving = false }
        do {
            // Belt-and-suspenders: never send a leaf still equal to the bullet
            // sentinel, so a masked secret can't be clobbered. (The backend also
            // preserves masked secrets, but we don't rely on that.)
            let payload = working.strippingMaskedLeaves(sentinel: maskedSentinel)
            let saved = try await api.updateSettings(payload)
            working = saved
            original = saved
        } catch {
            saveError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Connection info + a config editor. Boolean flags are editable; secrets show
/// as "hidden" and are never sent back as the bullet sentinel.
struct SettingsView: View {
    @Environment(ConnectionStore.self) private var connection
    @State private var vm: SettingsViewModel

    init() {
        // `connection.api` isn't available at init; the VM is created in .task.
        _vm = State(initialValue: SettingsViewModel(api: APIClient()))
    }

    @State private var didConfigure = false

    var body: some View {
        Form {
            Section("Connection") {
                LabeledContent("Host", value: connection.host ?? "—")
                if let count = connection.projectCount {
                    LabeledContent("Projects", value: "\(count)")
                }
            }

            switch vm.loadState {
            case .idle, .loading:
                Section { ProgressView().frame(maxWidth: .infinity) }
            case .failed(let message):
                Section { Text(message).foregroundStyle(.secondary) }
            case .loaded:
                ForEach(vm.sections, id: \.0) { section in
                    Section(section.0) {
                        ForEach(section.1) { row in
                            SettingLeafRow(row: row, vm: vm)
                        }
                    }
                }
            }

            Section {
                Button("Disconnect", role: .destructive) {
                    Task { await connection.disconnect() }
                }
            }
        }
        .navigationTitle("Settings")
        .toolbar {
            if vm.dirty {
                ToolbarItem(placement: .primaryAction) {
                    Button("Save") { Task { await vm.save() } }.disabled(vm.saving)
                }
            }
        }
        .task {
            if !didConfigure {
                didConfigure = true
                vm.injectAPI(connection.api)
                await vm.load()
            }
        }
        .alert("Save failed", isPresented: Binding(get: { vm.saveError != nil }, set: { if !$0 { vm.saveError = nil } }), presenting: vm.saveError) { _ in
            Button("OK", role: .cancel) {}
        } message: { Text($0) }
    }
}

private struct SettingLeafRow: View {
    let row: SettingsViewModel.LeafRow
    @Bindable var vm: SettingsViewModel

    var body: some View {
        switch row.value {
        case .bool:
            Toggle(row.label, isOn: vm.boolBinding(row.path))
        case .string(let s) where s == maskedSentinel:
            LabeledContent(row.label) { Label("hidden", systemImage: "lock.fill").foregroundStyle(.secondary).labelStyle(.iconOnly) }
        case .string(let s):
            LabeledContent(row.label, value: s.isEmpty ? "—" : s)
        case .number(let n):
            LabeledContent(row.label, value: n == n.rounded() ? "\(Int(n))" : "\(n)")
        default:
            EmptyView()
        }
    }
}

// MARK: - Config tree helpers

extension SettingsViewModel {
    struct LeafRow: Identifiable {
        let id: String
        let path: [String]
        let label: String
        let value: JSONValue
    }

    /// Grouped scalar leaves (depth ≤ 3) for the form.
    var sections: [(String, [LeafRow])] {
        guard case .object(let obj) = working else { return [] }
        var result: [(String, [LeafRow])] = []
        for topKey in obj.keys.sorted() {
            guard let topVal = obj[topKey] else { continue }
            var rows: [LeafRow] = []
            if case .object(let sub) = topVal {
                for subKey in sub.keys.sorted() {
                    guard let subVal = sub[subKey] else { continue }
                    if case .object(let sub2) = subVal {
                        for k2 in sub2.keys.sorted() where sub2[k2].map(Self.isScalar) == true {
                            rows.append(LeafRow(id: "\(topKey).\(subKey).\(k2)", path: [topKey, subKey, k2], label: "\(subKey).\(k2)", value: sub2[k2]!))
                        }
                    } else if Self.isScalar(subVal) {
                        rows.append(LeafRow(id: "\(topKey).\(subKey)", path: [topKey, subKey], label: subKey, value: subVal))
                    }
                }
            } else if Self.isScalar(topVal) {
                rows.append(LeafRow(id: topKey, path: [topKey], label: topKey, value: topVal))
            }
            if !rows.isEmpty { result.append((topKey, rows)) }
        }
        return result
    }

    static func isScalar(_ v: JSONValue) -> Bool {
        switch v {
        case .object, .array: return false
        default: return true
        }
    }

    func boolBinding(_ path: [String]) -> Binding<Bool> {
        Binding(
            get: { self.working.value(at: path)?.bool ?? false },
            set: { self.working = self.working.setting(path, to: .bool($0)) })
    }

    /// Swap in the real client once the environment is available (the VM is
    /// created in `init` with a throwaway client before the environment exists).
    func injectAPI(_ api: APIClient) { self.api = api }
}

extension JSONValue {
    func value(at path: [String]) -> JSONValue? {
        var current: JSONValue? = self
        for key in path { current = current?[key] }
        return current
    }

    /// Return a copy with the value at `path` replaced (creating objects as needed).
    func setting(_ path: [String], to newValue: JSONValue) -> JSONValue {
        guard let key = path.first else { return newValue }
        var object: [String: JSONValue]
        if case .object(let existing) = self { object = existing } else { object = [:] }
        let child = object[key] ?? .object([:])
        object[key] = child.setting(Array(path.dropFirst()), to: newValue)
        return .object(object)
    }

    /// Drop object leaves still equal to the mask sentinel (recursively).
    func strippingMaskedLeaves(sentinel: String) -> JSONValue {
        switch self {
        case .object(let obj):
            var out: [String: JSONValue] = [:]
            for (key, value) in obj {
                if case .string(let s) = value, s == sentinel { continue }
                out[key] = value.strippingMaskedLeaves(sentinel: sentinel)
            }
            return .object(out)
        case .array(let arr):
            return .array(arr.map { $0.strippingMaskedLeaves(sentinel: sentinel) })
        default:
            return self
        }
    }
}
