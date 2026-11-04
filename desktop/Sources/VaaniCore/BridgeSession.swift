import Foundation

/// Sends one message to the page. macOS: WKWebView.callAsyncJavaScript.
/// Returns false if the page is not the allowed page right now.
public protocol BridgeTransport: AnyObject {
    @discardableResult
    func send(_ message: NativeToWeb) -> Bool
}

/// Native side of the bridge, without WebKit. Owns sequence numbers, the
/// in-memory replay buffer and the "is the page ready" handshake.
public final class BridgeSession {
    public private(set) var pageReady = false
    public private(set) var current: SessionInfo?
    public private(set) var nextSeq = 0
    public private(set) var totalFrames = 0
    public private(set) var stoppedAt: TimeInterval?
    private var stopMessage: NativeToWeb?
    private var notices: [NativeToWeb] = []
    private var chunker = Chunker()
    private let replay: ReplayBuffer
    private weak var transport: BridgeTransport?

    /// After a session stops, keep audio this long for a page reload, then wipe.
    public let keepAfterStop: TimeInterval

    public init(transport: BridgeTransport?, replay: ReplayBuffer = ReplayBuffer(), keepAfterStop: TimeInterval = 600) {
        self.transport = transport
        self.replay = replay
        self.keepAfterStop = keepAfterStop
    }

    public func attach(_ transport: BridgeTransport) { self.transport = transport }

    public var bufferedBytes: Int { replay.byteCount }

    // MARK: Page lifecycle

    /// The page navigated or reloaded: it must say "ready" again.
    public func pageWillReload() { pageReady = false }

    /// Handle a parsed page message. Returns true if the page asked to stop.
    @discardableResult
    public func handle(_ message: WebToNative, now: TimeInterval) -> Bool {
        switch message {
        case .ready:
            pageReady = true
            transport?.send(.hello)
            if let s = current {
                transport?.send(.sessionStart(s))
                for n in notices { transport?.send(n) }
                replayChunks(from: replay.oldestSeq ?? 0, sessionID: s.id)
                if let stop = stopMessage { transport?.send(stop) }
            }
            return false
        case .resume(let sid, let from):
            guard pageReady, let s = current, s.id == sid else { return false }
            replayChunks(from: from, sessionID: sid)
            if let stop = stopMessage { transport?.send(stop) }
            return false
        case .sessionDone(let sid):
            if let s = current, s.id == sid, stopMessage != nil { wipe() }
            return false
        case .stop(let sid):
            guard let s = current, stopMessage == nil else { return false }
            return sid == nil || sid == s.id
        }
    }

    private func replayChunks(from seq: Int, sessionID: String) {
        for c in replay.chunks(fromSeq: seq) {
            transport?.send(.audioChunk(sessionID: sessionID, seq: c.seq, data: c.data))
        }
    }

    // MARK: Session lifecycle

    public func start(_ info: SessionInfo) {
        wipe()
        current = info
        if pageReady { transport?.send(.sessionStart(info)) }
    }

    public func notice(_ code: NoticeCode, _ message: String) {
        let n = NativeToWeb.notice(sessionID: current?.id, code: code, message: message)
        notices.append(n)
        if pageReady { transport?.send(n) }
    }

    /// Feed mixed 16 kHz mono samples.
    public func push(_ samples: [Float]) {
        guard current != nil, stopMessage == nil else { return }
        for chunk in chunker.push(samples) { emit(chunk) }
    }

    private func emit(_ samples: [Float]) {
        guard let s = current else { return }
        let data = PCM16.encode(samples)
        let seq = nextSeq
        nextSeq += 1
        totalFrames += samples.count
        replay.append(seq: seq, data: data)
        if pageReady { transport?.send(.audioChunk(sessionID: s.id, seq: seq, data: data)) }
    }

    public func stop(reason: StopReason, now: TimeInterval) {
        guard let s = current, stopMessage == nil else { return }
        if let tail = chunker.flush() { emit(tail) }
        let msg = NativeToWeb.sessionStop(sessionID: s.id, reason: reason, lastSeq: nextSeq - 1, totalFrames: totalFrames)
        stopMessage = msg
        stoppedAt = now
        if pageReady { transport?.send(msg) }
    }

    /// Call periodically. Wipes audio once the keep window has passed.
    public func tick(now: TimeInterval) {
        if let t = stoppedAt, now - t >= keepAfterStop { wipe() }
    }

    public var isActive: Bool { current != nil && stopMessage == nil }

    /// Forget the session and its audio.
    public func wipe() {
        replay.clear()
        current = nil
        stopMessage = nil
        stoppedAt = nil
        notices.removeAll()
        chunker = Chunker()
        nextSeq = 0
        totalFrames = 0
    }
}
