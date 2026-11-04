// macOS ONLY. Verified by macOS CI (compile) and by eye on a Mac.
//
// Small settings window: the ignored-apps list and "Record all Mac sound".
#if os(macOS)
import AppKit
import SwiftUI
import UniformTypeIdentifiers
import VaaniCore

@MainActor
final class SettingsModel: ObservableObject {
    @Published var settings: DetectionSettings
    /// Bound to the toggle directly ($model.captureAllSystemAudio), instead of
    /// Binding(get:set:) closures, which newer SDKs make @Sendable.
    @Published var captureAllSystemAudio: Bool {
        didSet {
            guard captureAllSystemAudio != settings.captureAllSystemAudio else { return }
            let value = captureAllSystemAudio
            update { $0.captureAllSystemAudio = value }
        }
    }
    private let store: SettingsStore
    var onChange: ((DetectionSettings) -> Void)?

    init(store: SettingsStore) {
        self.store = store
        let loaded = store.load()
        self.settings = loaded
        self.captureAllSystemAudio = loaded.captureAllSystemAudio
    }

    func update(_ change: (inout DetectionSettings) -> Void) {
        var s = settings
        change(&s)
        s = s.sanitized()
        settings = s
        store.save(s)
        onChange?(s)
    }

    func addApp() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.applicationBundle]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        let ids = panel.urls.compactMap { Bundle(url: $0)?.bundleIdentifier }
        update { $0.ignoredBundleIDs.append(contentsOf: ids) }
    }

    func remove(_ id: String) {
        guard id.caseInsensitiveCompare(VaaniIdentity.bundleID) != .orderedSame else { return }
        update { $0.ignoredBundleIDs.removeAll { $0 == id } }
    }

    func restoreDefaults() {
        update { $0.ignoredBundleIDs = DefaultIgnoreList.bundleIDs }
    }

    static func name(for bundleID: String) -> String {
        if bundleID == VaaniIdentity.bundleID { return "Vaani" }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        return AppCatalog.fallbackName(forBundleID: bundleID)
    }
}

struct SettingsView: View {
    @ObservedObject var model: SettingsModel
    @State private var selection: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Copy.ignoredHeading).font(.headline)
                Text(Copy.ignoredExplainer).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            List(selection: $selection) {
                ForEach(model.settings.ignoredBundleIDs, id: \.self) { id in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(SettingsModel.name(for: id))
                        Text(id).font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                    .tag(id)
                }
            }
            .frame(minHeight: 200)
            HStack {
                Button(Copy.addApp) { model.addApp() }
                Button(Copy.remove) { if let s = selection { model.remove(s); selection = nil } }
                    .disabled(selection == nil || selection == VaaniIdentity.bundleID)
                Spacer()
                Button(Copy.restoreDefaults) { model.restoreDefaults() }
            }
            Divider()
            Toggle(isOn: $model.captureAllSystemAudio) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Copy.captureAllTitle)
                    Text(Copy.captureAllExplainer).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(20)
        .frame(width: 460)
    }
}

@MainActor
final class SettingsWindowController {
    private var window: NSWindow?
    let model: SettingsModel

    init(model: SettingsModel) { self.model = model }

    func show() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 480),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = Copy.settingsTitle
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: SettingsView(model: model))
            w.center()
            window = w
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }
}
#endif
