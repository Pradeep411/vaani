// macOS ONLY. Verified by macOS CI (compile) and a real call (behaviour).
//
// Starts and stops one notes session: mic + system-audio tap -> mixer ->
// 250 ms PCM chunks -> BridgeSession (in memory only) -> the Vaani page.
//
// Security audit M-01: the tap is never widened to all Mac sound without the
// user saying yes. If the app-only tap has heard nothing at all, the user is
// asked ("Record all sound" / "Mic only"); no answer in 60 s means mic only.
// Re-audit N-05: `start` gets the scope the pill or menu promised. If the
// plan at start time is wider (all Mac sound) than that promise, recording
// starts mic only and the same question is asked first.
#if os(macOS)
import AVFoundation
import CoreAudio
import Foundation
import VaaniCore

@MainActor
final class RecordingController {
    let bridge: BridgeSession
    private(set) var isRecording = false
    private(set) var candidate: CallCandidate?
    private(set) var startedAt: Date?
    private(set) var captureMode: CaptureMode = .micOnly
    /// Last one-line message for the menu (nil when all is well).
    private(set) var notice: String?

    var onChange: (() -> Void)?
    /// Ask the user whether to record all Mac sound (show the pill).
    var onAskToWiden: ((String) -> Void)?
    /// The widen question timed out; hide its pill.
    var onWidenQuestionExpired: (() -> Void)?
    /// Supplies the current audio process list (from the detection loop).
    var processes: () -> [AudioProcessInfo] = { [] }
    /// Is the tapped app (or, for a wide tap, any app) playing sound right now?
    var isTargetPlaying: (CallCandidate?, Bool) -> Bool = { _, _ in false }

    private var mic: MicCapture?
    private var tap: AnyObject?                 // ProcessTapCapture on 14.2+
    private var mixer: AudioMixer?
    private var health: TapHealthMonitor?
    private let soundFlag = SoundFlag()
    private var drainTimer: Timer?
    private var outputListener: AudioObjectPropertyListenerBlock?
    private var permissionNoticeSent = false
    private var pageWarningShown = false
    private var widenAskedAt: TimeInterval?
    private static let widenAnswerTimeout: TimeInterval = 60

    init(bridge: BridgeSession) {
        self.bridge = bridge
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// The tap plan this call would get, so the pill and menu can say "all
    /// Mac sound" before recording starts.
    func plannedTap(for candidate: CallCandidate?, settings: DetectionSettings) -> TapPlan {
        TapPlanner.plan(for: candidate, processes: processes(), selfPID: getpid(),
                        captureAll: settings.captureAllSystemAudio)
    }

    // MARK: Start

    /// Returns false if recording could not start (microphone permission off).
    /// - Parameter promised: what the pill or menu item told the user.
    func start(candidate: CallCandidate?, settings: DetectionSettings, promised: CaptureScope) async -> Bool {
        guard !isRecording else { return true }
        guard await Self.microphoneAllowed() else {
            notice = Copy.micDenied
            onChange?()
            return false
        }

        let mixer = AudioMixer(sources: [.mic, .app])
        self.mixer = mixer
        let mic = MicCapture()
        mic.onSamples = { @Sendable samples in mixer.append(.mic, samples) }
        do {
            // Mic first, then the tap (Bluetooth headsets switch profile when
            // the mic opens; building the tap afterwards avoids silent taps).
            try mic.start()
        } catch {
            self.mixer = nil
            notice = Copy.micDenied
            onChange?()
            return false
        }
        self.mic = mic
        self.candidate = candidate
        self.startedAt = Date()
        self.isRecording = true
        self.permissionNoticeSent = false
        self.pageWarningShown = false
        self.widenAskedAt = nil
        self.notice = nil

        var startNotice: String?
        var startCode: NoticeCode = .tapUnavailable
        var askAfterStart = false
        if #available(macOS 14.2, *) {
            let plan = plannedTap(for: candidate, settings: settings)
            if ScopeDecision.decide(promised: promised, planned: plan) == .askBeforeAllSound {
                // Wider than promised: mic only until the user chooses.
                mixer.deactivate(.app)
                captureMode = .micOnly
                startNotice = Copy.micOnlyUntilChosen
                startCode = .micOnly
                askAfterStart = true
            } else if startTap(plan: plan) {
                captureMode = plan.isSystemWide ? .micAndSystem : .micAndApp
                health = TapHealthMonitor(startedAt: now)
                watchDefaultOutput()
                if plan.isSystemWide {
                    // Said before recording (pill or menu wording) and again here.
                    startNotice = Copy.systemWideFromStart
                    startCode = .systemWide
                }
            } else {
                mixer.deactivate(.app)
                captureMode = .micOnly
                startNotice = Copy.micOnlyTapFailed
            }
        } else {
            mixer.deactivate(.app)
            captureMode = .micOnly
            startNotice = Copy.micOnlyOldMac
        }

        bridge.start(SessionInfo(id: UUID().uuidString, startedAt: startedAt ?? Date(),
                                 appName: candidate?.displayName ?? "Vaani",
                                 bundleID: candidate?.bundleID, kind: candidate?.kind ?? .other,
                                 capture: captureMode, notice: startNotice))
        if let startNotice {
            notice = startNotice
            bridge.notice(startCode, startNotice)
        }

        if askAfterStart {
            widenAskedAt = now
            onAskToWiden?(candidate?.displayName ?? "the call app")
        }

        let relay = MainActorRelay(self)
        drainTimer = makeCommonModeTimer(interval: 0.25) {
            MainActor.assumeIsolated {
                if let owner = relay.owner { owner.drain() }
            }
        }
        onChange?()
        return true
    }

    @available(macOS 14.2, *)
    private func startTap(plan: TapPlan) -> Bool {
        (tap as? ProcessTapCapture)?.stop()
        let capture = ProcessTapCapture()
        let mixer = self.mixer
        let flag = soundFlag
        capture.onSamples = { @Sendable samples in
            if TapHealthMonitor.hasSound(samples) { flag.mark() }
            mixer?.append(.app, samples)
        }
        do {
            try capture.start(plan: plan)
            tap = capture
            return true
        } catch {
            NSLog("Vaani: system audio tap unavailable: %@", String(describing: error))
            tap = nil
            return false
        }
    }

    // MARK: Running

    private func drain() {
        guard isRecording, let mixer else { return }
        bridge.push(mixer.drain())
        bridge.tick(now: now)

        if #available(macOS 14.2, *), let health, let capture = tap as? ProcessTapCapture, let plan = capture.plan {
            health.observe(samples: soundFlag.take() ? [1] : [0], now: now)
            switch health.verdict(now: now, targetPlaying: isTargetPlaying(candidate, plan.isSystemWide),
                                  isSystemWide: plan.isSystemWide) {
            case .askToWiden:
                widenAskedAt = now
                onAskToWiden?(candidate?.displayName ?? "the call app")
            case .likelyNoPermission:
                showNotice(.tapSilent, Copy.tapSilent)
            case .healthy, .waiting:
                break
            }
        }
        if let asked = widenAskedAt, now - asked >= Self.widenAnswerTimeout {
            onWidenQuestionExpired?()
            keepMicOnly()                        // no answer: the safe choice
        }

        if !pageWarningShown, !bridge.pageReady, let startedAt, Date().timeIntervalSince(startedAt) > 15 {
            pageWarningShown = true
            notice = notice ?? Copy.pageNotReady
            onChange?()
        } else if pageWarningShown, bridge.pageReady, notice == Copy.pageNotReady {
            notice = nil
            onChange?()
        }
    }

    /// "Record all sound" on the pill.
    func widenToAllSound() {
        guard isRecording, widenAskedAt != nil else { return }
        widenAskedAt = nil
        guard #available(macOS 14.2, *) else { return }
        let own = processes().filter { $0.pid == getpid() }.map(\.objectID)
        mixer?.activate(.app)
        if startTap(plan: .systemWideExcluding(own)) {
            captureMode = .micAndSystem
            health = TapHealthMonitor(startedAt: now)
            if outputListener == nil { watchDefaultOutput() }
            notice = Copy.widenedByUser
            bridge.notice(.systemWide, Copy.widenedByUser)
            onChange?()
        } else {
            tapFailedMidSession()
        }
    }

    /// "Mic only" on the pill, or no answer.
    func keepMicOnly() {
        guard isRecording, widenAskedAt != nil else { return }
        widenAskedAt = nil
        if #available(macOS 14.2, *) { (tap as? ProcessTapCapture)?.stop() }
        tap = nil
        health = nil
        mixer?.deactivate(.app)
        captureMode = .micOnly
        notice = Copy.micOnlyChosen
        bridge.notice(.micOnly, Copy.micOnlyChosen)
        onChange?()
    }

    private func tapFailedMidSession() {
        if #available(macOS 14.2, *) { (tap as? ProcessTapCapture)?.stop() }
        tap = nil
        health = nil
        mixer?.deactivate(.app)
        captureMode = .micOnly
        showNotice(.tapUnavailable, Copy.micOnlyTapFailed)
    }

    private func showNotice(_ code: NoticeCode, _ text: String) {
        guard !permissionNoticeSent else { return }
        permissionNoticeSent = true
        notice = text
        bridge.notice(code, text)
        onChange?()
    }

    /// Rebuild the tap when the user switches speakers or headphones; the
    /// aggregate device is tied to the output device it was built on. The
    /// plan (and so the consent scope) stays the same.
    @available(macOS 14.2, *)
    private func watchDefaultOutput() {
        var addr = CoreAudioRead.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        // Core Audio calls this on the queue we pass (main). The block
        // captures only a Sendable weak relay, never `self`.
        let relay = MainActorRelay(self)
        let block: AudioObjectPropertyListenerBlock = { _, _ in
            MainActor.assumeIsolated {
                if let owner = relay.owner { owner.defaultOutputChanged() }
            }
        }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, block) == noErr {
            outputListener = block
        }
    }

    @available(macOS 14.2, *)
    private func defaultOutputChanged() {
        guard isRecording, let capture = tap as? ProcessTapCapture, let plan = capture.plan else { return }
        if !startTap(plan: plan) { tapFailedMidSession() }
    }

    private func unwatchDefaultOutput() {
        guard let block = outputListener else { return }
        var addr = CoreAudioRead.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, block)
        outputListener = nil
    }

    // MARK: Stop

    func stop(reason: StopReason) {
        guard isRecording else { return }
        drainTimer?.invalidate()
        drainTimer = nil
        unwatchDefaultOutput()
        if #available(macOS 14.2, *) { (tap as? ProcessTapCapture)?.stop() }
        tap = nil
        mic?.stop()
        mic = nil
        if let mixer { bridge.push(mixer.drain(flush: true)) }
        mixer = nil
        health = nil
        widenAskedAt = nil
        bridge.stop(reason: reason, now: now)
        isRecording = false
        candidate = nil
        startedAt = nil
        notice = nil
        onChange?()
    }

    var minutesRecorded: Int {
        guard let startedAt else { return 0 }
        return Int(Date().timeIntervalSince(startedAt) / 60)
    }

    // MARK: Permission

    static func microphoneAllowed() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
}
#endif
