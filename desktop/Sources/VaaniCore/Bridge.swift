import Foundation

/// The one web origin the desktop app trusts. Everything else is refused.
public enum BridgeConfig {
    public static let scheme = "https"
    public static let host = "pradeep411.github.io"
    public static let pathPrefix = "/vaani/"
    public static let startURL = URL(string: "https://pradeep411.github.io/vaani/?src=desktop")!
    /// window.webkit.messageHandlers.<handlerName>.postMessage(...)
    public static let handlerName = "vaaniDesktop"
    /// Name of the document-start user script shipped in the app bundle. It
    /// defines window.__VAANI_DESKTOP__ with connect(cb) / _deliver(msg).
    public static let userScriptName = "vaani-userscript"
    /// Placeholder in the user script that native replaces with a random
    /// token before injecting it. `_deliver` refuses any call without that
    /// token, so page scripts cannot feed fake messages (re-audit F-01).
    public static let deliverTokenPlaceholder = "__VAANI_DELIVER_TOKEN__"
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
            // Blank and srcdoc iframes only; the top page can never be blanked
            // (security audit L-04).
            let s = url.absoluteString.lowercased()
            return (!r.isMainFrame && (s == "about:blank" || s == "about:srcdoc")) ? .allow : .cancel
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

/// A page message plus the per-load nonce the page got in `hello`.
public struct ParsedWebMessage: Equatable {
    public var message: WebToNative
    public var nonce: String?
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
    public static func parse(_ body: Any) -> ParsedWebMessage? {
        guard let dict = body as? [String: Any], let message = parseMessage(dict) else { return nil }
        var nonce: String?
        if let n = dict["nonce"] {
            guard let ns = n as? String, isValidSessionID(ns) else { return nil }
            nonce = ns
        }
        return ParsedWebMessage(message: message, nonce: nonce)
    }

    private static func parseMessage(_ dict: [String: Any]) -> WebToNative? {
        guard JSONSerialization.isValidJSONObject(dict),
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
    /// Mic plus the call app's own sound.
    case micAndApp = "mic+app"
    /// Mic plus all Mac sound (except Vaani). The user is told before or as
    /// this starts (security audit M-01).
    case micAndSystem = "mic+system"
    case micOnly = "mic-only"
}

public enum NoticeCode: String, Sendable {
    /// System audio could not be recorded (permission or OS); mic only.
    case tapUnavailable = "tap-unavailable"
    /// The call app's sound has been silent for a while; maybe no permission.
    case tapSilent = "tap-silent"
    /// The microphone permission is off.
    case micDenied = "mic-denied"
    /// Recording all Mac sound for this session (said before it starts or
    /// after the user chose it).
    case systemWide = "system-wide"
    /// The user chose mic only for this session.
    case micOnly = "mic-only"
    /// The page asked for audio older than Vaani still keeps; `firstSeq`
    /// says where the kept audio starts.
    case gap = "gap"
}

public enum StopReason: String, Sendable {
    case user
    case callEnded = "call-ended"
    case webRequested = "web-requested"
    case error
    case quit
    /// "Still taking notes?" got no answer.
    case noAnswer = "no-answer"
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
    /// `nonce` is per page load; the page must echo it on every message
    /// except `ready` (security audit L-05).
    case hello(nonce: String)
    /// `firstSeq`: the oldest chunk Vaani still keeps for this session
    /// (security audit L-03).
    case sessionStart(SessionInfo, firstSeq: Int)
    case audioChunk(sessionID: String, seq: Int, data: Data)
    case notice(sessionID: String?, code: NoticeCode, message: String, firstSeq: Int? = nil)
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
        case .hello(let nonce):
            return ["v": v, "type": "hello", "protocol": v, "platform": "macos",
                    "nativeVersion": VaaniIdentity.version, "nonce": nonce,
                    "audio": Self.audioFormat]
        case .sessionStart(let s, let firstSeq):
            // Untrusted local text: cleaned here as well (audit L-06). The page
            // must still render it with textContent.
            var source: [String: Any] = ["app": SafeText.label(s.appName) ?? "Another app", "kind": s.kind.rawValue]
            if let b = SafeText.label(s.bundleID, maxLength: 255) { source["bundleId"] = b }
            var p: [String: Any] = ["v": v, "type": "session.start", "sessionId": s.id,
                                    "startedAt": Self.iso.string(from: s.startedAt),
                                    "source": source, "capture": s.capture.rawValue,
                                    "firstSeq": max(firstSeq, 0),
                                    "audio": Self.audioFormat]
            if let n = s.notice { p["notice"] = n }
            return p
        case .audioChunk(let sid, let seq, let data):
            return ["v": v, "type": "audio.chunk", "sessionId": sid, "seq": seq,
                    "frames": data.count / 2, "data": data.base64EncodedString()]
        case .notice(let sid, let code, let message, let firstSeq):
            var p: [String: Any] = ["v": v, "type": "capture.notice", "code": code.rawValue, "message": message]
            if let sid { p["sessionId"] = sid }
            if let firstSeq { p["firstSeq"] = firstSeq }
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
    /// the `msg` argument of callAsyncJavaScript and goes only to the single
    /// callback registered with __VAANI_DESKTOP__.connect (audit L-05). The
    /// `token` argument is the per-web-view secret baked into the user
    /// script; it exists only in that closure and in these call arguments,
    /// never in any page global (re-audit F-01).
    public static let dispatchScript =
        "const b = window.__VAANI_DESKTOP__; return !!(b && b._deliver(msg, token));"
}

/// Builds the user script that is injected at document start (re-audit F-01).
public enum UserScriptBuilder {
    /// A fresh random token: 32 hex characters (safe inside a JS string).
    public static func makeToken() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }

    public static func isValidToken(_ token: String) -> Bool {
        token.count >= 32 && token.count <= 64 && token.unicodeScalars.allSatisfy {
            ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f")
        }
    }

    /// Returns the script with the token in place, or nil (bridge stays
    /// closed) if the token is malformed or the placeholder does not appear
    /// exactly once.
    public static func build(source: String, token: String) -> String? {
        guard isValidToken(token) else { return nil }
        let parts = source.components(separatedBy: BridgeConfig.deliverTokenPlaceholder)
        guard parts.count == 2 else { return nil }
        return parts.joined(separator: token)
    }
}
