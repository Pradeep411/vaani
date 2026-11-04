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
    /// by the app process, so an app-only tap would hear nothing.
    public static let systemWideFamilies: Set<String> = ["facetime"]

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
            guard p.pid != selfPID, let b = p.bundleID else { return false }
            return patterns.contains { bundleID(b, matches: $0) }
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
public final class TapHealthMonitor {
    public enum Verdict: Equatable {
        case healthy
        case waiting
        /// App-only tap heard nothing while the app was playing sound:
        /// widen to all Mac sound (a helper process may own the audio).
        case widenToSystemWide
        /// Even the wide tap is silent while something plays: most likely the
        /// permission is off. Show the one-line notice once.
        case likelyNoPermission
    }

    public let silenceLimit: TimeInterval
    private var lastSoundAt: TimeInterval
    private var playingSince: TimeInterval?
    private var reported = false
    private(set) public var everHeardSound = false

    public init(startedAt: TimeInterval, silenceLimit: TimeInterval = 10) {
        self.silenceLimit = silenceLimit
        self.lastSoundAt = startedAt
    }

    /// Exact zeros mean "nothing delivered"; real audio always has some noise.
    public static func hasSound(_ samples: [Float]) -> Bool {
        samples.contains { $0 != 0 }
    }

    public func observe(samples: [Float], now: TimeInterval) {
        if Self.hasSound(samples) {
            lastSoundAt = now
            everHeardSound = true
        }
    }

    /// - Parameter targetPlaying: the tapped app (or anything, for a wide tap)
    ///   is currently sending audio to the speakers.
    public func verdict(now: TimeInterval, targetPlaying: Bool, isSystemWide: Bool) -> Verdict {
        if reported { return .healthy }
        guard targetPlaying else {
            playingSince = nil
            return everHeardSound ? .healthy : .waiting
        }
        let since = playingSince ?? now
        playingSince = since
        let silentFor = now - max(lastSoundAt, since)
        guard silentFor >= silenceLimit else { return everHeardSound ? .healthy : .waiting }
        if !isSystemWide {
            // Reset the clock for the widened tap.
            lastSoundAt = now
            playingSince = nil
            return .widenToSystemWide
        }
        reported = true
        return .likelyNoPermission
    }
}
