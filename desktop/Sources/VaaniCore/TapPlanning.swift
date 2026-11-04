import Foundation

/// Which processes the system-audio tap should listen to.
public enum TapPlan: Equatable {
    /// Only these audio process objects (the call app and its helpers).
    case processes([UInt32])
    /// All Mac sound except these process objects (Vaani itself).
    case systemWideExcluding([UInt32])

    public var isSystemWide: Bool {
        if case .systemWideExcluding = self { return true }
        return false
    }
}

public enum TapPlanner {
    /// Families whose far-end audio is usually played by a system daemon, not
    /// by the app process, so an app-only tap would hear nothing. These are
    /// recorded system-wide and the user is told so before recording.
    public static let systemWideFamilies: Set<String> = ["facetime"]

    /// Processes shared by many apps (every WebKit app has a GPU process).
    /// They are tapped only when they are the ones holding the call's mic,
    /// so a Safari call does not tap Mail or other web views (audit M-01).
    public static let sharedBundleIDs: [String] = ["com.apple.WebKit.GPU"]

    /// - Parameters:
    ///   - candidate: the call being recorded (nil for "Take notes now").
    ///   - processes: current audio processes from the OS.
    ///   - selfPID: Vaani's own process ID (always excluded).
    ///   - captureAll: user setting "Record all Mac sound".
    public static func plan(for candidate: CallCandidate?, processes: [AudioProcessInfo],
                            selfPID: Int32, captureAll: Bool) -> TapPlan {
        let own = processes.filter { $0.pid == selfPID }.map(\.objectID)
        guard !captureAll, let candidate, !systemWideFamilies.contains(candidate.familyID) else {
            return .systemWideExcluding(own)
        }
        let patterns: [String]
        if let app = AppCatalog.knownApp(familyID: candidate.familyID) {
            patterns = app.bundleIDs
        } else if let b = candidate.bundleID, !b.isEmpty {
            patterns = [b]
        } else {
            patterns = []
        }
        var ids = processes.filter { p in
            guard p.pid != selfPID, let b = p.bundleID, patterns.contains(where: { bundleID(b, matches: $0) }) else {
                return false
            }
            if sharedBundleIDs.contains(where: { bundleID(b, matches: $0) }) {
                return candidate.pids.contains(p.pid)
            }
            return true
        }.map(\.objectID)
        if ids.isEmpty {
            // Unknown app without a bundle ID: fall back to its process IDs.
            ids = processes.filter { candidate.pids.contains($0.pid) && $0.pid != selfPID }.map(\.objectID)
        }
        return ids.isEmpty ? .systemWideExcluding(own) : .processes(ids.sorted())
    }
}

/// Watches the tap for the silent-failure case: Core Audio returns no error
/// when the "System Audio Recording" permission is off, it just delivers zeros.
///
/// Security audit M-01: the app never widens to all Mac sound on its own.
/// It only *asks* (`askToWiden`), and only when the app-only tap has never
/// delivered a single non-zero sample this session. Once real sound has been
/// heard, a silent stretch is just silence.
public final class TapHealthMonitor {
    public enum Verdict: Equatable {
        case healthy
        case waiting
        /// App-only tap has heard nothing at all while the app was playing
        /// sound. Ask the user: record all Mac sound, or mic only?
        case askToWiden
        /// A system-wide tap has heard nothing at all while something played:
        /// most likely the permission is off. Show the one-line notice once.
        case likelyNoPermission
    }

    public let silenceLimit: TimeInterval
    private let startedAt: TimeInterval
    private var playingSince: TimeInterval?
    private var reported = false
    public private(set) var everHeardSound = false

    public init(startedAt: TimeInterval, silenceLimit: TimeInterval = 10) {
        self.silenceLimit = silenceLimit
        self.startedAt = startedAt
    }

    /// Exact zeros mean "nothing delivered"; real audio always has some noise.
    public static func hasSound(_ samples: [Float]) -> Bool {
        samples.contains { $0 != 0 }
    }

    public func observe(samples: [Float], now: TimeInterval) {
        if Self.hasSound(samples) { everHeardSound = true }
    }

    /// - Parameter targetPlaying: the tapped app (or, for a wide tap, any app)
    ///   is currently sending audio to the speakers.
    public func verdict(now: TimeInterval, targetPlaying: Bool, isSystemWide: Bool) -> Verdict {
        if everHeardSound || reported { return .healthy }
        guard targetPlaying else {
            playingSince = nil
            return .waiting
        }
        let since = playingSince ?? now
        playingSince = since
        guard now - max(startedAt, since) >= silenceLimit else { return .waiting }
        reported = true
        return isSystemWide ? .likelyNoPermission : .askToWiden
    }
}
