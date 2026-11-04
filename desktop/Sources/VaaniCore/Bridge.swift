import Foundation

/// The one web origin the desktop app trusts. Everything else is refused.
public enum BridgeConfig {
    public static let scheme = "https"
    public static let host = "pradeep411.github.io"
    public static let pathPrefix = "/vaani/"
    public static let startURL = URL(string: "https://pradeep411.github.io/vaani/?src=desktop")!
    /// window.webkit.messageHandlers.<handlerName>.postMessage(...)
    public static let handlerName = "vaaniDesktop"
    /// window.addEventListener(<eventName>, e => e.detail)
    public static let eventName = "vaani-desktop"
    public static let protocolVersion = 1
    /// Largest message the page may send to native, in bytes of JSON.
    public static let maxInboundBytes = 8 * 1024
}

// MARK: - Navigation policy

public enum NavigationDecision: Equatable {
    case allow
    case download
    case cancel
    case openExternally(URL)
}

public struct NavigationRequest {
    public var url: URL?
    public var isMainFrame: Bool
    /// The user clicked a link (WKNavigationType.linkActivated).
    public var userInitiated: Bool
    /// WebKit says this navigation is a download (a[download], blob export).
    public var shouldDownload: Bool
    /// The frame that started the navigation is our allowed page.
    public var sourceIsAllowed: Bool

    public init(url: URL?, isMainFrame: Bool, userInitiated: Bool = false, shouldDownload: Bool = false, sourceIsAllowed: Bool = false) {
        self.url = url
        self.isMainFrame = isMainFrame
        self.userInitiated = userInitiated
        self.shouldDownload = shouldDownload
        self.sourceIsAllowed = sourceIsAllowed
    }
}

public enum NavigationPolicy {
    private static let externalSchemes: Set<String> = ["https", "http", "mailto"]

    /// True only for https://pradeep411.github.io/vaani/... (no tricks).
    public static func isAllowedPage(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == BridgeConfig.scheme,
              url.host?.lowercased() == BridgeConfig.host,
              url.user == nil, url.password == nil else { return false }
        if let port = url.port, port != 443 { return false }
        // Work on the raw (still percent-encoded) path so "%2e%2e" or "%2f"
        // cannot smuggle a different directory past the prefix check.
        let raw = url.absoluteString
        guard let afterHost = raw.range(of: "://")
            .flatMap({ raw[$0.upperBound...].firstIndex(of: "/") })
            .map({ String(raw[$0...]) }) else { return false }
        let path = String(afterHost.prefix { $0 != "?" && $0 != "#" })
        let lowered = path.lowercased()
        if lowered.contains("%2e") || lowered.contains("%2f") || lowered.contains("%5c") || path.contains("\\") {
            return false
        }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        if segments.contains(where: { $0 == ".." || $0 == "." }) { return false }
        return path == "/vaani" || path.hasPrefix(BridgeConfig.pathPrefix)
    }

    public static func decide(_ r: NavigationRequest) -> NavigationDecision {
        if r.shouldDownload {
            return r.sourceIsAllowed ? .download : .cancel
        }
        guard let url = r.url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if scheme == "about" {
            let s = url.absoluteString.lowercased()
            return (s == "about:blank" || s == "about:srcdoc") ? .allow : .cancel
        }
        if isAllowedPage(url) { return .allow }
        if r.isMainFrame, r.userInitiated, externalSchemes.contains(scheme) {
            return .openExternally(url)
        }
        return .cancel
    }

    /// window.open / target=_blank: never a second web view. Real links go to
    /// the default browser, anything else is dropped.
    public static func decidePopup(_ url: URL?) -> NavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased(), externalSchemes.contains(scheme) else {
            return .cancel
        }
        return .openExternally(url)
    }
}

// MARK: - Message gate

public struct FrameOrigin: Equatable {
    public var scheme: String
    public var host: String
    /// WebKit reports 0 for the scheme's default port.
    public var port: Int
    public init(scheme: String, host: String, port: Int) {
        self.scheme = scheme
        self.host = host
        self.port = port
    }
}

public enum BridgeGate {
    /// Accept a page message only from the top frame of the allowed page.
    public static func accepts(isMainFrame: Bool, origin: FrameOrigin, pageURL: URL?) -> Bool {
        guard isMainFrame,
              origin.scheme.lowercased() == BridgeConfig.scheme,
              origin.host.lowercased() == BridgeConfig.host,
              origin.port == 0 || origin.port == 443 else { return false }
        return NavigationPolicy.isAllowedPage(pageURL)
    }

    /// Native checks the page again before every send.
    public static func maySend(to pageURL: URL?) -> Bool {
        NavigationPolicy.isAllowedPage(pageURL)
    }
}

// MARK: - Web -> native

public enum WebToNative: Equatable {
    /// The page has loaded the bridge and wants audio.
    case ready(protocolVersion: Int)
    /// The user pressed Stop inside the web app.
    case stop(sessionID: String?)
    /// Notes are made; native may wipe its copy of the audio.
    case sessionDone(sessionID: String)
    /// After a reload: send chunks again from this sequence number.
    case resume(sessionID: String, fromSeq: Int)
}

public enum BridgeParser {
    public static func isValidSessionID(_ s: String) -> Bool {
        guard (1...64).contains(s.count) else { return false }
        return s.unicodeScalars.allSatisfy { c in
            (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "-"
        }
    }

    private static func int(_ v: Any?) -> Int? {
        if let i = v as? Int { return i }
        if let d = v as? Double, d.rounded() == d, abs(d) < 1e12 { return Int(d) }
        return nil
    }

    /// Returns nil for anything unexpected. Unknown types are ignored, not errors.
    public static func parse(_ body: Any) -> WebToNative? {
        guard let dict = body as? [String: Any],
              JSONSerialization.isValidJSONObject(dict),
              let json = try? JSONSerialization.data(withJSONObject: dict),
              json.count <= BridgeConfig.maxInboundBytes else { return nil }
        guard int(dict["v"]) == BridgeConfig.protocolVersion, let type = dict["type"] as? String else { return nil }
        let sid = dict["sessionId"] as? String
        if let sid, !isValidSessionID(sid) { return nil }
        switch type {
        case "ready":
            guard let p = int(dict["protocol"]), p >= 1 else { return nil }
            return .ready(protocolVersion: p)
        case "stop":
            return .stop(sessionID: sid)
        case "session.done":
            guard let sid else { return nil }
            return .sessionDone(sessionID: sid)
        case "resume":
            guard let sid, let from = int(dict["fromSeq"]), from >= 0 else { return nil }
            return .resume(sessionID: sid, fromSeq: from)
        default:
            return nil
        }
    }
}

// MARK: - Native -> web

public enum CaptureMode: String, Sendable {
    case micAndApp = "mic+app"
    case micOnly = "mic-only"
}

public enum NoticeCode: String, Sendable {
    /// System audio could not be recorded (permission or OS); mic only.
    case tapUnavailable = "tap-unavailable"
    /// The call app's sound has been silent for a while; maybe no permission.
    case tapSilent = "tap-silent"
    /// The microphone permission is off.
    case micDenied = "mic-denied"
}

public enum StopReason: String, Sendable {
    case user
    case callEnded = "call-ended"
    case webRequested = "web-requested"
    case error
    case quit
}

public struct SessionInfo: Equatable, Sendable {
    public var id: String
    public var startedAt: Date
    public var appName: String
    public var bundleID: String?
    public var kind: CallKind
    public var capture: CaptureMode
    public var notice: String?

    public init(id: String, startedAt: Date, appName: String, bundleID: String?, kind: CallKind, capture: CaptureMode, notice: String? = nil) {
        self.id = id
        self.startedAt = startedAt
        self.appName = appName
        self.bundleID = bundleID
        self.kind = kind
        self.capture = capture
        self.notice = notice
    }
}

public enum NativeToWeb {
    case hello
    case sessionStart(SessionInfo)
    case audioChunk(sessionID: String, seq: Int, data: Data)
    case notice(sessionID: String?, code: NoticeCode, message: String)
    case sessionStop(sessionID: String, reason: StopReason, lastSeq: Int, totalFrames: Int)

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Plain JSON-compatible dictionary, passed to WebKit as an argument (never
    /// spliced into a script string).
    public var payload: [String: Any] {
        let v = BridgeConfig.protocolVersion
        switch self {
        case .hello:
            return ["v": v, "type": "hello", "protocol": v, "platform": "macos",
                    "nativeVersion": VaaniIdentity.version,
                    "audio": Self.audioFormat]
        case .sessionStart(let s):
            var source: [String: Any] = ["app": s.appName, "kind": s.kind.rawValue]
            if let b = s.bundleID { source["bundleId"] = b }
            var p: [String: Any] = ["v": v, "type": "session.start", "sessionId": s.id,
                                    "startedAt": Self.iso.string(from: s.startedAt),
                                    "source": source, "capture": s.capture.rawValue,
                                    "audio": Self.audioFormat]
            if let n = s.notice { p["notice"] = n }
            return p
        case .audioChunk(let sid, let seq, let data):
            return ["v": v, "type": "audio.chunk", "sessionId": sid, "seq": seq,
                    "frames": data.count / 2, "data": data.base64EncodedString()]
        case .notice(let sid, let code, let message):
            var p: [String: Any] = ["v": v, "type": "capture.notice", "code": code.rawValue, "message": message]
            if let sid { p["sessionId"] = sid }
            return p
        case .sessionStop(let sid, let reason, let lastSeq, let totalFrames):
            return ["v": v, "type": "session.stop", "sessionId": sid, "reason": reason.rawValue,
                    "lastSeq": lastSeq, "totalFrames": totalFrames]
        }
    }

    static let audioFormat: [String: Any] = [
        "encoding": "pcm_s16le",
        "sampleRate": Int(VaaniAudioFormat.sampleRate),
        "channels": VaaniAudioFormat.channels,
        "chunkMs": Int(Double(VaaniAudioFormat.chunkFrames) / VaaniAudioFormat.sampleRate * 1000)
    ]

    /// The only script native ever runs in the page. The message travels as
    /// the `msg` argument of callAsyncJavaScript.
    public static let dispatchScript =
        "window.dispatchEvent(new CustomEvent('\(BridgeConfig.eventName)', { detail: msg })); return true;"
}
