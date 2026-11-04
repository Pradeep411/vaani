// macOS ONLY. Verified by macOS CI (compile) and on a Mac (behaviour).
//
// Wires the pure detector (VaaniCore) to Core Audio, the prompt, the menu
// bar, the recorder and the notes window. Polls Core Audio once a second.
#if os(macOS)
import AppKit
import ServiceManagement
import VaaniCore

final class UserDefaultsStore: KeyValueStore {
    func data(forKey key: String) -> Data? { UserDefaults.standard.data(forKey: key) }
    func set(_ data: Data?, forKey key: String) { UserDefaults.standard.set(data, forKey: key) }
}

struct RunningAppNameResolver: AppNameResolving {
    func displayName(bundleID: String?, pid: Int32) -> String? {
        if let bundleID, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        return NSRunningApplication(processIdentifier: pid)?.localizedName
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let settingsStore = SettingsStore(store: UserDefaultsStore())
    private var settingsModel: SettingsModel!
    private var settingsWindow: SettingsWindowController!
    private let source = CoreAudioProcessSource()
    private var detector: MeetingDetector!
    private var loop: DetectionLoop!
    private let bridge = BridgeSession(transport: nil)
    private var recorder: RecordingController!
    private var notesWindow: VaaniWindowController?
    private lazy var prompt = PromptController()
    private var statusBar: StatusBarController!
    private var pollTimer: Timer?

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // NSApplicationDelegate entry points are nonisolated + assumeIsolated so
    // they match the protocol on both Xcode 15 and 16 SDKs (see
    // VaaniWindowController). AppKit always calls them on the main thread.
    nonisolated func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { launch() }
    }

    private func launch() {
        settingsModel = SettingsModel(store: settingsStore)
        settingsWindow = SettingsWindowController(model: settingsModel)
        detector = MeetingDetector(settings: settingsModel.settings, selfPID: getpid(),
                                   nameResolver: RunningAppNameResolver())
        loop = DetectionLoop(source: source, detector: detector,
                             clock: { ProcessInfo.processInfo.systemUptime },
                             selfWebViewCapturing: { [weak self] in
                                 MainActor.assumeIsolated { self?.notesWindow?.isCapturingMic ?? false }
                             })
        settingsModel.onChange = { [weak self] s in
            self?.detector.settings = s
            self?.statusBar.refresh()
        }

        recorder = RecordingController(bridge: bridge)
        recorder.processes = { [weak self] in self?.loop.lastProcesses ?? [] }
        recorder.isTargetPlaying = { [weak self] candidate, systemWide in
            guard let self else { return false }
            if systemWide || candidate == nil {
                return self.loop.lastProcesses.contains { $0.runningOutput && $0.pid != getpid() }
            }
            return self.loop.isPlaying(familyOf: candidate)
        }
        recorder.onChange = { [weak self] in self?.statusBar.refresh() }

        prompt.onTakeNotes = { [weak self] in self?.takeNotesFromPrompt() }
        prompt.onNotNow = { [weak self] in
            self?.detector.userSaidNotNow()
            self?.prompt.hide()
        }

        statusBar = StatusBarController()
        statusBar.snapshot = { [weak self] in
            guard let self else {
                return .init(detectionOn: false, recording: false, recordingApp: nil, minutes: 0, notice: nil, openAtLogin: false)
            }
            return .init(detectionOn: self.detector.settings.enabled,
                         recording: self.recorder.isRecording,
                         recordingApp: self.recorder.candidate?.displayName,
                         minutes: self.recorder.minutesRecorded,
                         notice: self.recorder.notice,
                         openAtLogin: SMAppService.mainApp.status == .enabled)
        }
        statusBar.onStop = { [weak self] in self?.stopRecording(.user) }
        statusBar.onTakeNotesNow = { [weak self] in self?.takeNotesNow() }
        statusBar.onOpenVaani = { [weak self] in self?.ensureNotesWindow().showAndFocus() }
        statusBar.onToggleDetection = { [weak self] in self?.settingsModel.update { $0.enabled.toggle() } }
        statusBar.onShowSettings = { [weak self] in self?.settingsWindow.show() }
        statusBar.onToggleLogin = { [weak self] in self?.toggleOpenAtLogin() }
        statusBar.onOpenPrivacySettings = { [weak self] in self?.openPrivacySettings() }
        statusBar.refresh()

        pollTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        pollTimer?.tolerance = 0.2
    }

    nonisolated func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    nonisolated func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            if recorder?.isRecording == true { recorder.stop(reason: .quit) }
            bridge.wipe()   // audio never outlives the app
        }
    }

    // MARK: Loop

    private func tick() {
        for event in loop.tick() {
            switch event {
            case .showPrompt(let c):
                if !recorder.isRecording { prompt.show(c) }
            case .hidePrompt:
                prompt.hide()
            case .autoStop:
                stopRecording(.callEnded)
            }
        }
        bridge.tick(now: now)
    }

    // MARK: Actions

    private func ensureNotesWindow() -> VaaniWindowController {
        if let w = notesWindow { return w }
        let w = VaaniWindowController(bridge: bridge)
        w.onStopRequested = { [weak self] in self?.stopRecording(.webRequested) }
        notesWindow = w
        return w
    }

    private func takeNotesFromPrompt() {
        prompt.hide()
        guard let candidate = detector.userTookNotes(now: now) else { return }
        startRecording(candidate)
    }

    private func takeNotesNow() {
        guard !recorder.isRecording else { return }
        prompt.hide()
        let live = detector.currentLiveCall()
        detector.manualRecordingStarted(now: now, attachTo: live)
        startRecording(live)
    }

    private func startRecording(_ candidate: CallCandidate?) {
        ensureNotesWindow().showQuietly()
        let settings = detector.settings
        Task { @MainActor in
            let ok = await recorder.start(candidate: candidate, settings: settings)
            if !ok {
                detector.recordingEnded(now: now)
                showMicrophoneAlert()
            }
            statusBar.refresh()
        }
    }

    private func stopRecording(_ reason: StopReason) {
        guard recorder.isRecording else { return }
        recorder.stop(reason: reason)
        detector.recordingEnded(now: now)
        statusBar.refresh()
    }

    private func showMicrophoneAlert() {
        let alert = NSAlert()
        alert.messageText = Copy.micDenied
        alert.addButton(withTitle: Copy.openSettings)
        alert.addButton(withTitle: Copy.notNow)
        NSApp.activate()
        if alert.runModal() == .alertFirstButtonReturn {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        }
    }

    private func openPrivacySettings() {
        if recorder.notice == Copy.micDenied {
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        } else {
            // "Screen & System Audio Recording" pane; Vaani is listed under
            // "System Audio Recording Only".
            open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        }
    }

    private func open(_ string: String) {
        if let url = URL(string: string) { NSWorkspace.shared.open(url) }
    }

    private func toggleOpenAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = Copy.loginItemFailed
            alert.runModal()
        }
        statusBar.refresh()
    }
}
#endif
