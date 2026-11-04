import Foundation

/// Text that came from outside Vaani (app names and bundle IDs on disk) is
/// cleaned before it is shown or sent to the page (security audit L-06).
public enum SafeText {
    /// Drops control, format (bidi overrides, zero-width) and separator
    /// characters, trims, and caps the length. nil when nothing is left.
    public static func label(_ text: String?, maxLength: Int = 64) -> String? {
        guard let text else { return nil }
        var scalars = String.UnicodeScalarView()
        for s in text.unicodeScalars {
            switch s.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator, .surrogate, .privateUse, .unassigned:
                continue
            default:
                scalars.append(s)
            }
        }
        let cleaned = String(scalars).trimmingCharacters(in: .whitespaces)
        guard !cleaned.isEmpty else { return nil }
        return cleaned.count > maxLength ? String(cleaned.prefix(maxLength)) : cleaned
    }
}

/// Opening a link in the default browser needs a real, recent click in the
/// notes window, and at most one open per second, so script in the page
/// cannot flood the browser (security audit L-04).
public final class ExternalOpenGate {
    public let clickWindow: TimeInterval
    public let minInterval: TimeInterval
    private var lastOpen: TimeInterval = -.infinity

    public init(clickWindow: TimeInterval = 1, minInterval: TimeInterval = 1) {
        self.clickWindow = clickWindow
        self.minInterval = minInterval
    }

    /// Records the open when it returns true.
    public func allows(now: TimeInterval, lastClickAt: TimeInterval?, windowIsKey: Bool) -> Bool {
        guard windowIsKey, let click = lastClickAt, now >= click, now - click <= clickWindow,
              now - lastOpen >= minInterval else { return false }
        lastOpen = now
        return true
    }
}

/// Reload delays after the page's web process crashes: 1 s, 5 s, 30 s, then
/// give up until the user opens the window again (security audit L-02).
public struct ReloadBackoff {
    public let delays: [TimeInterval]
    /// A crash this long after the previous one starts the count again.
    public let stableAfter: TimeInterval
    private var count = 0
    private var lastCrash: TimeInterval = -.infinity

    public init(delays: [TimeInterval] = [1, 5, 30], stableAfter: TimeInterval = 120) {
        self.delays = delays
        self.stableAfter = stableAfter
    }

    /// nil means "do not reload again".
    public mutating func nextDelay(now: TimeInterval) -> TimeInterval? {
        if now - lastCrash > stableAfter { count = 0 }
        lastCrash = now
        defer { count += 1 }
        return count < delays.count ? delays[count] : nil
    }

    public mutating func reset() {
        count = 0
        lastCrash = -.infinity
    }
}

// MARK: - Build flavour (security re-audit D-01)

/// The normal app, or the no-sandbox diagnostic build used only to tell
/// sandbox problems apart from other faults on a test Mac. The diagnostic
/// build must never look like, or store data like, the real app.
public enum BuildFlavor: Equatable, Sendable {
    case standard
    case diagnostic

    /// Info.plist key that build-app.sh sets to true for SANDBOX=0 builds.
    public static let infoKey = "VaaniDiagnosticBuild"
    public static let diagnosticBundleID = VaaniIdentity.bundleID + ".diagnostic"
    public static let diagnosticName = "Vaani DIAGNOSTIC"

    /// Fails safe: anything that is not clearly a sandboxed standard build is
    /// treated as diagnostic (no login item, no stored web data).
    /// - Parameters:
    ///   - infoFlag: value of `VaaniDiagnosticBuild` in Info.plist.
    ///   - sandboxContainerID: `APP_SANDBOX_CONTAINER_ID` from the environment
    ///     (set by macOS only for sandboxed apps).
    public static func detect(infoFlag: Any?, sandboxContainerID: String?) -> BuildFlavor {
        if let flag = infoFlag as? Bool, flag { return .diagnostic }
        if let flag = infoFlag as? String, ["1", "true", "yes"].contains(flag.lowercased()) { return .diagnostic }
        guard let container = sandboxContainerID, !container.isEmpty else { return .diagnostic }
        return .standard
    }

    public var allowsLoginItem: Bool { self == .standard }
    public var persistsWebData: Bool { self == .standard }
}

// MARK: - Notes window rules (security re-audit N-04)

public enum NotesWindowPolicy {
    /// The page may hold the mic only while its window is really on screen
    /// (visible, not minimised, app not hidden).
    public static func mustForceMicOff(pageCapturing: Bool, windowOnScreen: Bool) -> Bool {
        pageCapturing && !windowOnScreen
    }

    /// Unload the page once it has nothing left to deliver and is not shown.
    public static func shouldTearDown(windowOnScreen: Bool, recording: Bool, sessionBuffered: Bool) -> Bool {
        !windowOnScreen && !recording && !sessionBuffered
    }
}

// MARK: - Promised capture scope (security re-audit N-05)

/// What the pill or menu item told the user before recording.
public enum CaptureScope: Equatable, Sendable {
    /// "Take notes with Vaani?": the call app's own sound.
    case callAppOnly
    /// "Records your mic and all Mac sound" / "with all Mac sound".
    case allMacSound

    public init(plan: TapPlan) {
        self = plan.isSystemWide ? .allMacSound : .callAppOnly
    }
}

public enum ScopeDecision: Equatable, Sendable {
    /// Start the tap as planned: it is within what the user was told.
    case proceed
    /// The plan became wider than promised: start mic only and ask first.
    case askBeforeAllSound

    public static func decide(promised: CaptureScope, planned: TapPlan) -> ScopeDecision {
        (promised == .callAppOnly && planned.isSystemWide) ? .askBeforeAllSound : .proceed
    }
}
