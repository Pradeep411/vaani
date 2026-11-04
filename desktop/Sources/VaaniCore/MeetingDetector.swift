import Foundation

// MARK: - Inputs (portable: macOS fills these from Core Audio; Windows later
// from WASAPI session enumeration)

/// One process the audio system knows about.
public struct AudioProcessInfo: Equatable, Sendable {
    /// Opaque OS handle (Core Audio process AudioObjectID on macOS).
    public var objectID: UInt32
    public var pid: Int32
    public var bundleID: String?
    public var runningInput: Bool
    public var runningOutput: Bool

    public init(objectID: UInt32 = 0, pid: Int32, bundleID: String?, runningInput: Bool, runningOutput: Bool = false) {
        self.objectID = objectID
        self.pid = pid
        self.bundleID = bundleID
        self.runningInput = runningInput
        self.runningOutput = runningOutput
    }
}

/// Reads the current audio processes. Returns nil when the per-process API is
/// not available, in which case `isMicRunningSomewhere` is the fallback.
public protocol AudioProcessSource: AnyObject {
    func currentProcesses() -> [AudioProcessInfo]?
    func isMicRunningSomewhere() -> Bool
}

/// Turns a process into a name a person recognises ("Zoom", "Notion").
public protocol AppNameResolving {
    func displayName(bundleID: String?, pid: Int32) -> String?
}

public struct NoNameResolver: AppNameResolving {
    public init() {}
    public func displayName(bundleID: String?, pid: Int32) -> String? { nil }
}

public struct DetectorInput: Equatable {
    public var now: TimeInterval
    /// nil means "per-process data unavailable".
    public var processes: [AudioProcessInfo]?
    public var micRunningSomewhere: Bool
    /// True while Vaani's own notes window is using the mic (web dictation).
    public var selfWebViewCapturing: Bool

    public init(now: TimeInterval, processes: [AudioProcessInfo]?, micRunningSomewhere: Bool = false, selfWebViewCapturing: Bool = false) {
        self.now = now
        self.processes = processes
        self.micRunningSomewhere = micRunningSomewhere
        self.selfWebViewCapturing = selfWebViewCapturing
    }
}

// MARK: - Outputs

public struct CallCandidate: Equatable, Sendable {
    public var familyID: String
    public var displayName: String
    public var kind: CallKind
    public var isKnownCallApp: Bool
    /// Representative bundle ID (main app if known, else what the OS reported).
    public var bundleID: String?
    public var pids: [Int32]
    public var priority: Int

    /// "Meeting detected · Zoom"
    public var title: String { "\(kind.headline) · \(displayName)" }
}

public enum PromptHideReason: Equatable, Sendable {
    case callEnded
    case timedOut
    case detectionTurnedOff
}

public enum AutoStopReason: Equatable, Sendable {
    /// The call app stopped using the microphone (the call ended).
    case callEnded(CallCandidate)
    /// "Still taking notes?" got no answer.
    case noAnswer
}

public enum DetectorEvent: Equatable, Sendable {
    case showPrompt(CallCandidate)
    case hidePrompt(PromptHideReason)
    /// Long session: ask "Still taking notes?" (stops if unanswered).
    case askStillTakingNotes(CallCandidate?)
    case autoStop(AutoStopReason)
}

public enum DetectorState: Equatable {
    case idle
    case prompting(CallCandidate, shownAt: TimeInterval)
    case recording(CallCandidate?, startedAt: TimeInterval)
}

// MARK: - Detector

/// Pure state machine. Feed it `update(_:)` about once a second. It never
/// touches the OS, so every rule here is unit-tested.
public final class MeetingDetector {
    public private(set) var state: DetectorState = .idle
    public var settings: DetectionSettings

    private let selfPID: Int32
    private let nameResolver: AppNameResolving

    private struct Track {
        var candidate: CallCandidate
        var firstInputAt: TimeInterval
        var lastInputAt: TimeInterval
        /// Last time the call counted as "still on" (for auto-stop). Mic use
        /// always counts. Speaker use counts only for native call apps and
        /// only shortly after the last mic use (security audit H-01).
        var lastAliveAt: TimeInterval
        var dismissedForThisCall: Bool
    }

    private var tracks: [String: Track] = [:]
    private var cooldownUntil: TimeInterval = -.infinity
    private var autoStopSent = false
    private var lastNow: TimeInterval = 0
    /// "Still taking notes?" schedule for the current recording.
    private var nextCheckAt: TimeInterval = .infinity
    private var checkAskedAt: TimeInterval?

    public static let fallbackFamilyID = "unknown"

    public init(settings: DetectionSettings, selfPID: Int32, nameResolver: AppNameResolving = NoNameResolver()) {
        self.settings = settings.sanitized()
        self.selfPID = selfPID
        self.nameResolver = nameResolver
    }

    // MARK: Classification

    /// nil means "ignore this process".
    public func classify(_ p: AudioProcessInfo) -> CallCandidate? {
        if p.pid == selfPID { return nil }
        if settings.isIgnored(bundleID: p.bundleID) { return nil }
        if let app = AppCatalog.knownApp(forBundleID: p.bundleID) {
            return CallCandidate(familyID: app.familyID, displayName: app.displayName, kind: app.kind,
                                 isKnownCallApp: true, bundleID: app.bundleIDs.first, pids: [p.pid],
                                 priority: app.priority)
        }
        // Names come from app bundles on disk: strip control and bidi
        // characters and cap the length before they go anywhere (audit L-06).
        let name = SafeText.label(nameResolver.displayName(bundleID: p.bundleID, pid: p.pid))
            ?? SafeText.label(AppCatalog.fallbackName(forBundleID: p.bundleID))
            ?? "Another app"
        let family = (p.bundleID?.isEmpty == false) ? "bundle:\(p.bundleID!.lowercased())" : "pid:\(p.pid)"
        return CallCandidate(familyID: family, displayName: name, kind: .other, isKnownCallApp: false,
                             bundleID: SafeText.label(p.bundleID, maxLength: 255), pids: [p.pid], priority: 0)
    }

    private func debounce(for c: CallCandidate) -> TimeInterval {
        c.isKnownCallApp ? settings.knownAppDebounce : settings.otherAppDebounce
    }

    /// Speaker use keeps a call "on" only for native call apps (a muted Zoom
    /// user still hears the call), never for browsers (a YouTube tab is not
    /// a call), and only for a bounded time after the last mic use.
    private func outputCountsAsAlive(_ c: CallCandidate) -> Bool {
        c.isKnownCallApp && c.kind != .browser
    }

    // MARK: Update

    @discardableResult
    public func update(_ input: DetectorInput) -> [DetectorEvent] {
        let now = input.now
        lastNow = now
        var events: [DetectorEvent] = []

        // 1. Who is using the mic / speaker right now, grouped by app family.
        var inputFamilies: [String: CallCandidate] = [:]
        var outputFamilies: [String: CallCandidate] = [:]
        if let processes = input.processes {
            for p in processes where p.runningInput || p.runningOutput {
                guard let c = classify(p) else { continue }
                if p.runningOutput { outputFamilies[c.familyID] = c }
                if p.runningInput {
                    if var existing = inputFamilies[c.familyID] {
                        existing.pids.append(contentsOf: c.pids)
                        inputFamilies[c.familyID] = existing
                    } else {
                        inputFamilies[c.familyID] = c
                    }
                }
            }
        } else if input.micRunningSomewhere && !isRecording {
            // Fallback: we only know that *something* uses the mic. While
            // Vaani records, its own mic keeps this true, so it says nothing
            // about the other app (audit H-01).
            let c = CallCandidate(familyID: Self.fallbackFamilyID, displayName: "Another app", kind: .other,
                                  isKnownCallApp: false, bundleID: nil, pids: [], priority: 0)
            inputFamilies[c.familyID] = c
        }

        // 2. Update per-family call tracks.
        for (id, c) in inputFamilies {
            if var t = tracks[id], now - t.lastInputAt <= settings.newCallGap {
                t.lastInputAt = now
                t.lastAliveAt = now
                t.candidate.pids = c.pids
                tracks[id] = t
            } else {
                tracks[id] = Track(candidate: c, firstInputAt: now, lastInputAt: now, lastAliveAt: now,
                                   dismissedForThisCall: false)
            }
        }
        for (id, c) in outputFamilies where inputFamilies[id] == nil {
            guard var t = tracks[id], outputCountsAsAlive(c),
                  now - t.lastInputAt <= settings.outputGraceAfterInput else { continue }
            t.lastAliveAt = now
            tracks[id] = t
        }
        // Forget calls that ended long ago (but never the one being recorded).
        let recordingFamily: String? = {
            if case .recording(let c, _) = state { return c?.familyID }
            return nil
        }()
        tracks = tracks.filter { id, t in
            id == recordingFamily || now - t.lastAliveAt <= max(settings.newCallGap, settings.autoStopAfter) + 5
        }

        // 3. State machine.
        switch state {
        case .idle:
            if let c = bestEligible(now: now, input: input, inputFamilies: inputFamilies) {
                state = .prompting(c, shownAt: now)
                events.append(.showPrompt(c))
            }

        case .prompting(let c, let shownAt):
            if !settings.enabled {
                state = .idle
                events.append(.hidePrompt(.detectionTurnedOff))
            } else if let t = tracks[c.familyID], inputFamilies[c.familyID] == nil,
                      now - t.lastInputAt >= settings.promptHideGrace {
                state = .idle
                events.append(.hidePrompt(.callEnded))
            } else if tracks[c.familyID] == nil {
                state = .idle
                events.append(.hidePrompt(.callEnded))
            } else if now - shownAt >= settings.promptTimeout {
                tracks[c.familyID]?.dismissedForThisCall = true
                state = .idle
                events.append(.hidePrompt(.timedOut))
            }

        case .recording(let c, _):
            guard !autoStopSent else { break }
            // a) The call app let go of the microphone.
            if let c, c.familyID != Self.fallbackFamilyID {
                let lastAlive = tracks[c.familyID]?.lastAliveAt ?? -.infinity
                if now - lastAlive >= settings.autoStopAfter {
                    autoStopSent = true
                    events.append(.autoStop(.callEnded(c)))
                    break
                }
            }
            // b) Hard ceiling: "Still taking notes?", stop if unanswered.
            if let asked = checkAskedAt {
                if now - asked >= settings.stillThereTimeout {
                    autoStopSent = true
                    events.append(.autoStop(.noAnswer))
                }
            } else if now >= nextCheckAt {
                checkAskedAt = now
                events.append(.askStillTakingNotes(c))
            }
        }
        return events
    }

    private func bestEligible(now: TimeInterval, input: DetectorInput,
                              inputFamilies: [String: CallCandidate]) -> CallCandidate? {
        guard settings.enabled, now >= cooldownUntil, !input.selfWebViewCapturing else { return nil }
        let eligible = inputFamilies.keys.compactMap { id -> Track? in
            guard let t = tracks[id], !t.dismissedForThisCall else { return nil }
            return now - t.firstInputAt >= debounce(for: t.candidate) ? t : nil
        }
        return eligible.sorted { a, b in
            if a.candidate.priority != b.candidate.priority { return a.candidate.priority > b.candidate.priority }
            if a.firstInputAt != b.firstInputAt { return a.firstInputAt < b.firstInputAt }
            return a.candidate.familyID < b.candidate.familyID
        }.first?.candidate
    }

    /// Time until the next "Still taking notes?" for a session.
    private func checkInterval(for c: CallCandidate?) -> TimeInterval {
        guard let c, c.familyID != Self.fallbackFamilyID else { return settings.manualCheckInterval }
        return settings.maxSessionLength
    }

    private func beginRecording(_ c: CallCandidate?, now: TimeInterval) {
        autoStopSent = false
        checkAskedAt = nil
        nextCheckAt = now + checkInterval(for: c)
        state = .recording(c, startedAt: now)
    }

    // MARK: User and app actions

    /// "Take notes" on the prompt. Returns the call being recorded.
    @discardableResult
    public func userTookNotes(now: TimeInterval) -> CallCandidate? {
        guard case .prompting(let c, _) = state else { return nil }
        tracks[c.familyID]?.dismissedForThisCall = true
        beginRecording(c, now: now)
        return c
    }

    /// "Not now": no more prompts for this call.
    public func userSaidNotNow() {
        guard case .prompting(let c, _) = state else { return }
        tracks[c.familyID]?.dismissedForThisCall = true
        state = .idle
    }

    /// Recording started from the menu ("Take notes now") with no prompt.
    /// If a call app is live, it is attached for auto-stop.
    public func manualRecordingStarted(now: TimeInterval, attachTo candidate: CallCandidate? = nil) {
        if let c = candidate { tracks[c.familyID]?.dismissedForThisCall = true }
        beginRecording(candidate, now: now)
    }

    /// "Keep going" on the "Still taking notes?" check.
    public func userKeepGoing(now: TimeInterval) {
        guard case .recording(let c, _) = state, checkAskedAt != nil, !autoStopSent else { return }
        checkAskedAt = nil
        nextCheckAt = now + checkInterval(for: c)
    }

    public var isAskingStillTakingNotes: Bool { checkAskedAt != nil }

    public func recordingEnded(now: TimeInterval) {
        if case .recording(let c, _) = state, let c {
            tracks[c.familyID]?.dismissedForThisCall = true
        }
        cooldownUntil = now + settings.cooldownAfterRecording
        autoStopSent = false
        checkAskedAt = nil
        nextCheckAt = .infinity
        state = .idle
    }

    /// The live call app with the most priority, for "Take notes now".
    public func currentLiveCall() -> CallCandidate? {
        tracks.values
            .filter { lastNow - $0.lastInputAt <= 2 && $0.candidate.familyID != Self.fallbackFamilyID }
            .sorted { $0.candidate.priority > $1.candidate.priority }
            .first?.candidate
    }

    public var isRecording: Bool {
        if case .recording = state { return true }
        return false
    }
}

// MARK: - Loop

/// Glue between an OS audio source and the detector. The app calls `tick()`
/// once a second; tests call it with a fake source and a fake clock.
public final class DetectionLoop {
    public let detector: MeetingDetector
    private let source: AudioProcessSource
    private let clock: () -> TimeInterval
    private let selfWebViewCapturing: () -> Bool
    public private(set) var lastProcesses: [AudioProcessInfo] = []

    public init(source: AudioProcessSource, detector: MeetingDetector,
                clock: @escaping () -> TimeInterval,
                selfWebViewCapturing: @escaping () -> Bool = { false }) {
        self.source = source
        self.detector = detector
        self.clock = clock
        self.selfWebViewCapturing = selfWebViewCapturing
    }

    public var now: TimeInterval { clock() }

    @discardableResult
    public func tick() -> [DetectorEvent] {
        let processes = source.currentProcesses()
        lastProcesses = processes ?? []
        let input = DetectorInput(now: clock(), processes: processes,
                                  micRunningSomewhere: processes == nil ? source.isMicRunningSomewhere() : false,
                                  selfWebViewCapturing: selfWebViewCapturing())
        return detector.update(input)
    }

    /// Is any of these processes sending sound to the speakers right now?
    public func isPlaying(familyOf candidate: CallCandidate?) -> Bool {
        guard let candidate else { return lastProcesses.contains { $0.runningOutput } }
        return lastProcesses.contains { p in
            p.runningOutput && detector.classify(p)?.familyID == candidate.familyID
        }
    }
}
