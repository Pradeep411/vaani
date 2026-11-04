import Foundation

/// Everything the user (or a later settings screen) can change about
/// detection. All times are seconds.
public struct DetectionSettings: Codable, Equatable, Sendable {
    /// Master switch. Off means no prompts at all.
    public var enabled: Bool = true
    /// Bundle IDs that never trigger a prompt (exact or dotted prefix).
    public var ignoredBundleIDs: [String] = DefaultIgnoreList.bundleIDs
    /// How long a known call app must hold the mic before we ask.
    public var knownAppDebounce: TimeInterval = 3
    /// How long any other app must hold the mic before we ask.
    public var otherAppDebounce: TimeInterval = 20
    /// Stop notes when the call app has not used the microphone this long.
    public var autoStopAfter: TimeInterval = 60
    /// A native call app playing sound (a muted user still hearing the call)
    /// keeps the call "on" for at most this long after its last mic use.
    /// Browsers never count sound as "on".
    public var outputGraceAfterInput: TimeInterval = 300
    /// Ask "Still taking notes?" after this long on a call session.
    public var maxSessionLength: TimeInterval = 7200
    /// Ask "Still taking notes?" this often for "Take notes now" sessions
    /// and when the app cannot tell which app holds the mic.
    public var manualCheckInterval: TimeInterval = 3600
    /// Stop if "Still taking notes?" gets no answer this long.
    public var stillThereTimeout: TimeInterval = 120
    /// No prompts at all for this long after a recording ends.
    public var cooldownAfterRecording: TimeInterval = 60
    /// If an app lets go of the mic for this long, its next use is a new call.
    public var newCallGap: TimeInterval = 15
    /// Hide the prompt if the app lets go of the mic for this long.
    public var promptHideGrace: TimeInterval = 5
    /// Hide an unanswered prompt after this long (counts as "Not now").
    public var promptTimeout: TimeInterval = 60
    /// Record all Mac sound instead of only the call app.
    public var captureAllSystemAudio: Bool = false

    public init() {}

    public func isIgnored(bundleID id: String?) -> Bool {
        guard let id, !id.isEmpty else { return false }
        return ignoredBundleIDs.contains { pattern in
            let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            return !trimmed.isEmpty && bundleID(id, matches: trimmed)
        }
    }

    /// Clamp values a hand-edited or corrupted store could make unsafe.
    public func sanitized() -> DetectionSettings {
        var s = self
        s.knownAppDebounce = min(max(s.knownAppDebounce, 1), 120)
        s.otherAppDebounce = min(max(s.otherAppDebounce, 3), 600)
        s.autoStopAfter = min(max(s.autoStopAfter, 15), 1800)
        s.outputGraceAfterInput = min(max(s.outputGraceAfterInput, 0), 1800)
        s.maxSessionLength = min(max(s.maxSessionLength, 1800), 14400)
        s.manualCheckInterval = min(max(s.manualCheckInterval, 900), 14400)
        s.stillThereTimeout = min(max(s.stillThereTimeout, 30), 600)
        s.cooldownAfterRecording = min(max(s.cooldownAfterRecording, 0), 1800)
        s.newCallGap = min(max(s.newCallGap, 3), 600)
        s.promptHideGrace = min(max(s.promptHideGrace, 1), 60)
        s.promptTimeout = min(max(s.promptTimeout, 10), 600)
        var seen = Set<String>()
        s.ignoredBundleIDs = s.ignoredBundleIDs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && $0.count <= 255 && seen.insert($0.lowercased()).inserted }
        if !s.ignoredBundleIDs.contains(where: { $0.caseInsensitiveCompare(VaaniIdentity.bundleID) == .orderedSame }) {
            s.ignoredBundleIDs.append(VaaniIdentity.bundleID)
        }
        return s
    }

    // Tolerant decoding: a missing key keeps its default, so adding a new
    // setting never wipes the user's ignore list.
    private enum CodingKeys: String, CodingKey {
        case enabled, ignoredBundleIDs, knownAppDebounce, otherAppDebounce, autoStopAfter,
             outputGraceAfterInput, maxSessionLength, manualCheckInterval, stillThereTimeout,
             cooldownAfterRecording, newCallGap, promptHideGrace, promptTimeout, captureAllSystemAudio
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = DetectionSettings()
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? d.enabled
        ignoredBundleIDs = (try? c.decode([String].self, forKey: .ignoredBundleIDs)) ?? d.ignoredBundleIDs
        knownAppDebounce = (try? c.decode(Double.self, forKey: .knownAppDebounce)) ?? d.knownAppDebounce
        otherAppDebounce = (try? c.decode(Double.self, forKey: .otherAppDebounce)) ?? d.otherAppDebounce
        autoStopAfter = (try? c.decode(Double.self, forKey: .autoStopAfter)) ?? d.autoStopAfter
        outputGraceAfterInput = (try? c.decode(Double.self, forKey: .outputGraceAfterInput)) ?? d.outputGraceAfterInput
        maxSessionLength = (try? c.decode(Double.self, forKey: .maxSessionLength)) ?? d.maxSessionLength
        manualCheckInterval = (try? c.decode(Double.self, forKey: .manualCheckInterval)) ?? d.manualCheckInterval
        stillThereTimeout = (try? c.decode(Double.self, forKey: .stillThereTimeout)) ?? d.stillThereTimeout
        cooldownAfterRecording = (try? c.decode(Double.self, forKey: .cooldownAfterRecording)) ?? d.cooldownAfterRecording
        newCallGap = (try? c.decode(Double.self, forKey: .newCallGap)) ?? d.newCallGap
        promptHideGrace = (try? c.decode(Double.self, forKey: .promptHideGrace)) ?? d.promptHideGrace
        promptTimeout = (try? c.decode(Double.self, forKey: .promptTimeout)) ?? d.promptTimeout
        captureAllSystemAudio = (try? c.decode(Bool.self, forKey: .captureAllSystemAudio)) ?? d.captureAllSystemAudio
    }
}

/// Where settings live. macOS uses UserDefaults; tests use memory.
public protocol KeyValueStore: AnyObject {
    func data(forKey key: String) -> Data?
    func set(_ data: Data?, forKey key: String)
}

public final class InMemoryKeyValueStore: KeyValueStore {
    private var storage: [String: Data] = [:]
    public init() {}
    public func data(forKey key: String) -> Data? { storage[key] }
    public func set(_ data: Data?, forKey key: String) { storage[key] = data }
}

public final class SettingsStore {
    public static let key = "vaani.detection.settings.v1"
    private let store: KeyValueStore

    public init(store: KeyValueStore) { self.store = store }

    public func load() -> DetectionSettings {
        guard let data = store.data(forKey: Self.key),
              let s = try? JSONDecoder().decode(DetectionSettings.self, from: data) else {
            return DetectionSettings()
        }
        return s.sanitized()
    }

    public func save(_ settings: DetectionSettings) {
        let data = try? JSONEncoder().encode(settings.sanitized())
        store.set(data, forKey: Self.key)
    }
}
