// macOS ONLY. Verified by macOS CI (compile) and on a Mac (behaviour).
//
// Wires the pure detector (VaaniCore) to Core Audio, the pill, the menu
// bar, the recorder and the notes window. Polls Core Audio once a second.
#if os(macOS)
import AppKit
import ServiceManagement
import VaaniCore

final class UserDefaultsStore: KeyValueStore {
    func data(forKey key: String) -> Data? { UserDefaults.standard.data(forKey: key) }
    func set(_ data: Data?, forKey key: String) { UserDefaults.standard.set(data, forKey: key) }
}

/// Reads an app's name from its bundle on disk. The detector cleans the
/// result (SafeText) before it is shown or sent anywhere.
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
    private var prompt: PromptController!
    private var statusBar: StatusBarController!
    private var pollTimer: Timer?
    /// Standard or the no-sandbox diagnostic build (re-audit D-01).
    private var flavor: BuildFlavor = .diagnostic
    /// What the call pill told the user about capture scope (re-audit N-05).
    private var promisedScope: CaptureScope = .callAppOnly

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // NSApplicationDelegate entry points are nonisolated + assumeIsolated so
    // they match the protocol on both Xcode 15 and 16 SDKs (see
    // VaaniWindowController). AppKit always calls them on the main thread.
    nonisolated func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated { launch() }
    }

    nonisolated func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    nonisolated func applicationWillTerminate(_ notification: Notification) {
        MainActor.assumeIsolated {
            if recorder?.isRecording == true { recorder.stop(reason: .quit) }
            bridge.wipe()   // audio never outlives the app
        }
    }

    private func launch() {
        flavor = BuildFlavor.detect(
            infoFlag: Bundle.main.object(forInfoDictionaryKey: BuildFlavor.infoKey),
            sandboxContainerID: ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"])
        if !flavor.allowsLoginItem, SMAppService.mainApp.status == .enabled {
            try? SMAppService.mainApp.unregister()
        }
        prompt = PromptController()
        settingsModel = SettingsModel(store: settingsStore)
        settingsWindow = SettingsWindowController(model: settingsModel)
        detector = MeetingDetector(settings: settingsModel.settings, selfPID: getpid(),
                                   nameResolver: RunningAppNameResolver())
        let relay = MainActorRelay(self)
        loop = DetectionLoop(source: source, detector: detector,
                             clock: { ProcessInfo.processInfo.systemUptime },
                             selfWebViewCapturing: {
                                 MainActor.assumeIsolated { relay.owner?.notesWindow?.isCapturingMic ?? false }
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
        recorder.onChange = { [weak self] in self?.recordingStateChanged() }
        recorder.onAskToWiden = { [weak self] app in self?.askToWiden(app) }
        recorder.onWidenQuestionExpired = { [weak self] in self?.prompt.hide(ifShowing: .askToWiden) }

        statusBar = StatusBarController()
        statusBar.snapshot = { [weak self] in
            guard let self else {
                return .init(detectionOn: false, recording: false, recordingApp: nil, minutes: 0, notice: nil,
                             pageUsingMic: false, takeNotesNowAllSound: true, openAtLogin: false,
                             diagnostic: true)
            }
            return .init(detectionOn: self.detector.settings.enabled,
                         recording: self.recorder.isRecording,
                         recordingApp: self.recorder.candidate?.displayName,
                         minutes: self.recorder.minutesRecorded,
                         notice: self.recorder.notice ?? self.notesWindow?.crashNotice,
                         pageUsingMic: self.notesWindow?.isCapturingMic ?? false,
                         takeNotesNowAllSound: self.recorder.plannedTap(for: self.detector.currentLiveCall(),
                                                                        settings: self.detector.settings).isSystemWide,
                         openAtLogin: self.flavor.allowsLoginItem && SMAppService.mainApp.status == .enabled,
                         diagnostic: self.flavor == .diagnostic)
        }
        statusBar.onStop = { [weak self] in self?.stopRecording(.user) }
        statusBar.onTakeNotesNow = { [weak self] promised in self?.takeNotesNow(promised: promised) }
        statusBar.onOpenVaani = { [weak self] in self?.openVaani() }
        statusBar.onToggleDetection = { [weak self] in self?.settingsModel.update { $0.enabled.toggle() } }
        statusBar.onShowSettings = { [weak self] in self?.settingsWindow.show() }
        statusBar.onToggleLogin = { [weak self] in self?.toggleOpenAtLogin() }
        statusBar.onOpenPrivacySettings = { [weak self] in self?.openPrivacySettings() }
        statusBar.refresh()

        // Common run-loop modes: keeps detecting and auto-stopping while a
        // menu is open or a panel is up (security audit L-01).
        pollTimer = makeCommonModeTimer(interval: 1, tolerance: 0.2) {
            MainActor.assumeIsolated {
                if let owner = relay.owner { owner.tick() }
            }
        }
    }

    // MARK: Loop

    private func tick() {
        for event in loop.tick() {
            switch event {
            case .showPrompt(let c):
                if !recorder.isRecording { showCallPrompt(c) }
            case .hidePrompt:
                prompt.hide(ifShowing: .callDetected)
            case .askStillTakingNotes(let c):
                askStillTakingNotes(c)
            case .autoStop(let reason):
                prompt.hide(ifShowing: .stillTakingNotes)
                switch reason {
                case .callEnded: stopRecording(.callEnded)
                case .noAnswer: stopRecording(.noAnswer)
                }
            }
        }
        bridge.tick(now: now)
        // Re-audit N-04: a page kept loaded only to receive a session is
        // unloaded once that session is released and the window stays closed.
        if let w = notesWindow, w.closedByUser,
           NotesWindowPolicy.shouldTearDown(windowOnScreen: w.isOnScreen, recording: recorder.isRecording,
                                            sessionBuffered: bridge.current != nil) {
            w.tearDown()
            notesWindow = nil
        }
        statusBar.refresh()
    }

    // MARK: Pills

    private func showCallPrompt(_ c: CallCandidate) {
        // Say "all Mac sound" before recording when that is what will happen
        // (FaceTime, unknown apps, or the setting is on) (audit M-01).
        let allSound = recorder.plannedTap(for: c, settings: detector.settings).isSystemWide
        promisedScope = allSound ? .allMacSound : .callAppOnly
        let content = PillContent(
            kind: .callDetected,
            title: c.title,
            subtitle: allSound ? Copy.promptQuestionAllSound : Copy.promptQuestion,
            announcement: Copy.promptAnnouncement(c),
            icon: PromptController.icon(forBundleID: c.bundleID, pid: c.pids.first),
            secondaryLabel: Copy.notNow,
            secondaryHint: Copy.notNowHint,
            primaryLabel: Copy.takeNotes,
            primaryHint: Copy.takeNotesHint(c.displayName))
        prompt.show(content, primary: { [weak self] in self?.takeNotesFromPrompt() },
                    secondary: { [weak self] in self?.detector.userSaidNotNow() })
    }

    private func askStillTakingNotes(_ c: CallCandidate?) {
        let content = PillContent(
            kind: .stillTakingNotes,
            title: Copy.stillTitle,
            subtitle: Copy.stillSubtitle,
            announcement: Copy.stillAnnouncement,
            icon: nil,
            secondaryLabel: Copy.stop,
            secondaryHint: Copy.menuStop,
            primaryLabel: Copy.keepGoing,
            primaryHint: Copy.stillTitle)
        prompt.show(content, primary: { [weak self] in
            guard let self else { return }
            self.detector.userKeepGoing(now: self.now)
        }, secondary: { [weak self] in
            self?.stopRecording(.user)
        })
    }

    private func askToWiden(_ app: String) {
        // Never cover "Still taking notes?"; with no answer the recorder
        // falls back to mic only, the safe choice.
        guard prompt.kind != .stillTakingNotes else { return }
        let content = PillContent(
            kind: .askToWiden,
            title: Copy.widenTitle(app),
            subtitle: Copy.widenSubtitle,
            announcement: Copy.widenAnnouncement(app),
            icon: nil,
            secondaryLabel: Copy.micOnly,
            secondaryHint: Copy.micOnlyChosen,
            primaryLabel: Copy.recordAllSound,
            primaryHint: Copy.widenedByUser)
        prompt.show(content, primary: { [weak self] in self?.recorder.widenToAllSound() },
                    secondary: { [weak self] in self?.recorder.keepMicOnly() })
    }

    // MARK: Actions

    private func ensureNotesWindow() -> VaaniWindowController {
        if let w = notesWindow, w.crashNotice == nil { return w }
        notesWindow?.tearDown()
        let w = VaaniWindowController(bridge: bridge, flavor: flavor)
        w.onStopRequested = { [weak self] in self?.stopRecording(.webRequested) }
        w.onPageStateChange = { [weak self] in self?.statusBar.refresh() }
        w.onClosed = { [weak self] in self?.notesWindowClosed() }
        notesWindow = w
        return w
    }

    private func openVaani() {
        ensureNotesWindow().showAndFocus()
    }

    /// Closed with nothing to deliver: unload the page so it cannot keep
    /// running (or listening) in the background (audit M-02). With a session
    /// still buffered, the page stays loaded (hidden) to receive the audio.
    private func notesWindowClosed() {
        guard !recorder.isRecording, bridge.current == nil else { return }
        notesWindow?.tearDown()
        notesWindow = nil
        statusBar.refresh()
    }

    private func recordingStateChanged() {
        notesWindow?.setRecording(recorder.isRecording)
        statusBar.refresh()
    }

    private func takeNotesFromPrompt() {
        guard let candidate = detector.userTookNotes(now: now) else { return }
        let promise = promisedScope
        promisedScope = .callAppOnly   // default for next time: "this app only"
        startRecording(candidate, promised: promise)
    }

    /// - Parameter promised: what the menu item said when the menu opened.
    private func takeNotesNow(promised: CaptureScope) {
        guard !recorder.isRecording else { return }
        prompt.hide(ifShowing: .callDetected)
        let live = detector.currentLiveCall()
        detector.manualRecordingStarted(now: now, attachTo: live)
        startRecording(live, promised: promised)
    }

    private func startRecording(_ candidate: CallCandidate?, promised: CaptureScope) {
        ensureNotesWindow().showQuietly()
        let settings = detector.settings
        Task { @MainActor in
            let ok = await recorder.start(candidate: candidate, settings: settings, promised: promised)
            if !ok {
                detector.recordingEnded(now: now)
                showMicrophoneAlert()
            }
            recordingStateChanged()
        }
    }

    private func stopRecording(_ reason: StopReason) {
        prompt.hide(ifShowing: .stillTakingNotes)
        prompt.hide(ifShowing: .askToWiden)
        guard recorder.isRecording else { return }
        recorder.stop(reason: reason)
        detector.recordingEnded(now: now)
        recordingStateChanged()
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
        guard flavor.allowsLoginItem else { return }   // never for the diagnostic build
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            let alert = NSAlert()
            alert.messageText = Copy.loginItemFailed
            _ = alert.runModal()
        }
        statusBar.refresh()
    }
}
#endif
