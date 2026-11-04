// macOS ONLY. Verified by macOS CI (compile) and a real call (behaviour).
//
// Starts and stops one notes session: mic + system-audio tap -> mixer ->
// 250 ms PCM chunks -> BridgeSession (in memory only) -> the Vaani page.
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
    private var noticeSent = false
    private var pageWarningShown = false
    private var settings = DetectionSettings()

    init(bridge: BridgeSession) {
        self.bridge = bridge
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    // MARK: Start

    /// Returns false if recording could not start (microphone permission off).
    func start(candidate: CallCandidate?, settings: DetectionSettings) async -> Bool {
        guard !isRecording else { return true }
        self.settings = settings
        guard await Self.microphoneAllowed() else {
            notice = Copy.micDenied
            onChange?()
            return false
        }

        let mixer = AudioMixer(sources: [.mic, .app])
        self.mixer = mixer
        let mic = MicCapture()
        mic.onSamples = { samples in mixer.append(.mic, samples) }
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
        self.noticeSent = false
        self.pageWarningShown = false
        self.notice = nil

        var startNotice: String?
        if #available(macOS 14.2, *) {
            if startTap(plan: TapPlanner.plan(for: candidate, processes: processes(),
                                              selfPID: getpid(), captureAll: settings.captureAllSystemAudio)) {
                captureMode = .micAndApp
                health = TapHealthMonitor(startedAt: now)
                watchDefaultOutput()
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
            bridge.notice(.tapUnavailable, startNotice)
        }

        drainTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.drain() }
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
        capture.onSamples = { samples in
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

        // Silent-tap check (permission off, or audio owned by another process).
        if #available(macOS 14.2, *), let health, let capture = tap as? ProcessTapCapture, let plan = capture.plan {
            health.observe(samples: soundFlag.take() ? [1] : [0], now: now)
            switch health.verdict(now: now, targetPlaying: isTargetPlaying(candidate, plan.isSystemWide),
                                  isSystemWide: plan.isSystemWide) {
            case .widenToSystemWide:
                let own = processes().filter { $0.pid == getpid() }.map(\.objectID)
                if !startTap(plan: .systemWideExcluding(own)) { tapFailedMidSession() }
            case .likelyNoPermission:
                showNotice(.tapSilent, Copy.tapSilent)
            case .healthy, .waiting:
                break
            }
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

    private func tapFailedMidSession() {
        tap = nil
        mixer?.deactivate(.app)
        captureMode = .micOnly
        showNotice(.tapUnavailable, Copy.micOnlyTapFailed)
    }

    private func showNotice(_ code: NoticeCode, _ text: String) {
        guard !noticeSent else { return }
        noticeSent = true
        notice = text
        bridge.notice(code, text)
        onChange?()
    }

    /// Rebuild the tap when the user switches speakers or headphones; the
    /// aggregate device is tied to the output device it was built on.
    @available(macOS 14.2, *)
    private func watchDefaultOutput() {
        var addr = CoreAudioRead.address(kAudioHardwarePropertyDefaultSystemOutputDevice)
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.isRecording, let capture = self.tap as? ProcessTapCapture,
                          let plan = capture.plan else { return }
                    if !self.startTap(plan: plan) { self.tapFailedMidSession() }
                }
            }
        }
        if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main, block) == noErr {
            outputListener = block
        }
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
