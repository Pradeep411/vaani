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
