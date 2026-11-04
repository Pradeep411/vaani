import Foundation

/// What kind of conversation an app usually hosts. Drives the prompt headline.
public enum CallKind: String, Codable, Equatable, Sendable {
    case meeting   // Zoom, Teams, Webex
    case call      // WhatsApp, FaceTime, Discord, Telegram, Signal
    case huddle    // Slack
    case browser   // Google Meet and other web calls
    case other     // anything else that holds the mic long enough

    /// Plain words shown at the start of the prompt.
    public var headline: String {
        switch self {
        case .meeting, .browser, .other: return "Meeting detected"
        case .call: return "Call detected"
        case .huddle: return "Huddle detected"
        }
    }
}

/// One app family. Several bundle IDs (main app, helper processes, old and
/// new builds) can belong to one family, e.g. Chrome and its helpers.
public struct KnownApp: Equatable, Sendable {
    public let familyID: String
    public let displayName: String
    public let kind: CallKind
    /// Matched as exact ID or as a prefix followed by "." (case-insensitive).
    public let bundleIDs: [String]
    /// Native call apps outrank browsers when two apps qualify at once.
    public var priority: Int { kind == .browser ? 1 : 2 }

    public init(familyID: String, displayName: String, kind: CallKind, bundleIDs: [String]) {
        self.familyID = familyID
        self.displayName = displayName
        self.kind = kind
        self.bundleIDs = bundleIDs
    }
}

/// Matches `id` against `pattern` as an exact ID or a dotted prefix.
/// "com.google.Chrome" matches "com.google.Chrome.helper" but not
/// "com.google.Chromecast".
public func bundleID(_ id: String, matches pattern: String) -> Bool {
    let a = id.lowercased()
    let p = pattern.lowercased()
    return a == p || a.hasPrefix(p + ".")
}

/// The built-in list of call apps. Bundle IDs marked "verify" are best
/// knowledge and should be confirmed on a real Mac (see README-DESKTOP.md).
public enum AppCatalog {
    public static let known: [KnownApp] = [
        KnownApp(familyID: "zoom", displayName: "Zoom", kind: .meeting,
                 bundleIDs: ["us.zoom.xos"]),
        KnownApp(familyID: "teams", displayName: "Microsoft Teams", kind: .meeting,
                 bundleIDs: ["com.microsoft.teams2", "com.microsoft.teams"]),
        KnownApp(familyID: "webex", displayName: "Webex", kind: .meeting,
                 bundleIDs: ["Cisco-Systems.Spark", "com.webex.meetingmanager", "com.cisco.webexmeetingsapp"]),
        KnownApp(familyID: "whatsapp", displayName: "WhatsApp", kind: .call,
                 bundleIDs: ["net.whatsapp.WhatsApp", "desktop.WhatsApp"]),
        // FaceTime call audio is often handled by the avconferenced daemon
        // rather than FaceTime.app itself (verify on device).
        KnownApp(familyID: "facetime", displayName: "FaceTime", kind: .call,
                 bundleIDs: ["com.apple.FaceTime", "com.apple.avconferenced"]),
        KnownApp(familyID: "slack", displayName: "Slack", kind: .huddle,
                 bundleIDs: ["com.tinyspeck.slackmacgap"]),
        KnownApp(familyID: "discord", displayName: "Discord", kind: .call,
                 bundleIDs: ["com.hnc.Discord"]),
        KnownApp(familyID: "telegram", displayName: "Telegram", kind: .call,
                 bundleIDs: ["ru.keepcoder.Telegram", "org.telegram.desktop"]),
        KnownApp(familyID: "signal", displayName: "Signal", kind: .call,
                 bundleIDs: ["org.whispersystems.signal-desktop"]),
        // Browsers. Google Meet runs inside these. Mic and speaker audio is
        // usually owned by a helper process, which the prefix rule catches.
        KnownApp(familyID: "chrome", displayName: "Chrome", kind: .browser,
                 bundleIDs: ["com.google.Chrome"]),
        // Safari captures the mic in the shared WebKit GPU process. That
        // process also serves other WebKit apps, so "Safari" is a best guess.
        KnownApp(familyID: "safari", displayName: "Safari", kind: .browser,
                 bundleIDs: ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.apple.WebKit.GPU"]),
        KnownApp(familyID: "arc", displayName: "Arc", kind: .browser,
                 bundleIDs: ["company.thebrowser.Browser"]),
        KnownApp(familyID: "dia", displayName: "Dia", kind: .browser,
                 bundleIDs: ["company.thebrowser.dia"]),
        KnownApp(familyID: "edge", displayName: "Edge", kind: .browser,
                 bundleIDs: ["com.microsoft.edgemac"]),
        KnownApp(familyID: "brave", displayName: "Brave", kind: .browser,
                 bundleIDs: ["com.brave.Browser"]),
        KnownApp(familyID: "firefox", displayName: "Firefox", kind: .browser,
                 bundleIDs: ["org.mozilla.firefox", "org.mozilla.nightly"]),
        KnownApp(familyID: "opera", displayName: "Opera", kind: .browser,
                 bundleIDs: ["com.operasoftware.Opera"]),
        KnownApp(familyID: "vivaldi", displayName: "Vivaldi", kind: .browser,
                 bundleIDs: ["com.vivaldi.Vivaldi"])
    ]

    public static func knownApp(forBundleID id: String?) -> KnownApp? {
        guard let id, !id.isEmpty else { return nil }
        return known.first { app in app.bundleIDs.contains { bundleID(id, matches: $0) } }
    }

    public static func knownApp(familyID: String) -> KnownApp? {
        known.first { $0.familyID == familyID }
    }

    /// A readable name from a bundle ID when the OS gives none:
    /// "com.example.MeetingApp" -> "MeetingApp".
    public static func fallbackName(forBundleID id: String?) -> String {
        guard let id, let last = id.split(separator: ".").last, !last.isEmpty else {
            return "Another app"
        }
        return String(last)
    }
}

/// Default apps that use the mic but are not calls.
public enum DefaultIgnoreList {
    public static let bundleIDs: [String] = [
        // Dictation tools
        "com.electron.wispr-flow",          // Wispr Flow (verify)
        "com.wispr.flow",                   // Wispr Flow, alternate ID (verify)
        "com.superduper.superwhisper",      // Superwhisper
        "com.goodsnooze.MacWhisper",        // MacWhisper
        // macOS dictation, Siri and "Hey Siri" listening
        "com.apple.DictationIM",
        "com.apple.SpeechRecognitionCore",
        "com.apple.speech",
        "com.apple.corespeechd",
        "com.apple.assistantd",
        "com.apple.Siri",
        "com.apple.accessibility.heard",    // Sound Recognition
        // Recorders
        "com.apple.VoiceMemos",
        // Vaani itself (also excluded by process ID)
        VaaniIdentity.bundleID
    ]
}

public enum VaaniIdentity {
    public static let bundleID = "io.github.pradeep411.vaani.desktop"
    public static let version = "0.1.0"
}
