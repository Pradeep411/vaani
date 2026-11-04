import Foundation

/// Sends one message to the page. macOS: WKWebView.callAsyncJavaScript.
/// Returns false if the page is not the allowed page right now.
public protocol BridgeTransport: AnyObject {
    @discardableResult
    func send(_ message: NativeToWeb) -> Bool
}

/// Native side of the bridge, without WebKit. Owns sequence numbers, the
/// in-memory replay buffer, the per-load nonce and the "is the page ready"
/// handshake.
///
/// Security audit fixes in here:
///  * L-02: catching a page up ("ready", "resume") never sends more than
///    `replayBatch` chunks per `tick`/message, only one replay runs at a time,
///    `ready` counts once per page load and at most once per
///    `readyMinInterval` across reloads (later ones are deferred, not lost),
///    and `resume` at most once per `resumeMinInterval`.
///  * L-03: `session.start` carries `firstSeq`; a `resume` from before the
///    oldest kept chunk gets a `gap` notice with `firstSeq`.
///  * L-05 / N-02: every page message except `ready` must carry the nonce
///    sent in `hello`; a new nonce is made for every page load. The page's
///    user script keeps the nonce in its closure; page scripts never see it.
///  * N-03: if `hello` reaches no listener, the handshake is reset.
public final class BridgeSession {
    public private(set) var pageReady = false
    public private(set) var pageNonce: String
    public private(set) var current: SessionInfo?
    public private(set) var nextSeq = 0
    public private(set) var totalFrames = 0
    public private(set) var stoppedAt: TimeInterval?
    private var stopMessage: NativeToWeb?
    private var stopSent = false
    private var notices: [NativeToWeb] = []
    private var chunker = Chunker()
    private let replay: ReplayBuffer
    private weak var transport: BridgeTransport?
    private let makeNonce: () -> String

    /// Non-nil while the page is being caught up: next sequence to send.
    private var replayCursor: Int?
    private var lastReadyAt: TimeInterval = -.infinity
    private var deferredReady = false
    private var lastResumeAt: TimeInterval = -.infinity

    /// After a session stops, keep audio this long for a page reload, then release it.
    public let keepAfterStop: TimeInterval
    public let replayBatch: Int
    public let readyMinInterval: TimeInterval
    public let resumeMinInterval: TimeInterval

    public init(transport: BridgeTransport?, replay: ReplayBuffer = ReplayBuffer(), keepAfterStop: TimeInterval = 600,
                replayBatch: Int = 200, readyMinInterval: TimeInterval = 5, resumeMinInterval: TimeInterval = 5,
                makeNonce: @escaping () -> String = { UUID().uuidString }) {
        self.transport = transport
        self.replay = replay
        self.keepAfterStop = keepAfterStop
        self.replayBatch = max(1, replayBatch)
        self.readyMinInterval = readyMinInterval
        self.resumeMinInterval = resumeMinInterval
        self.makeNonce = makeNonce
        self.pageNonce = makeNonce()
    }

    public func attach(_ transport: BridgeTransport) { self.transport = transport }

    public var bufferedBytes: Int { replay.byteCount }
    public var isReplaying: Bool { replayCursor != nil }

    // MARK: Page lifecycle

    /// The page navigated or reloaded: it must say "ready" again, and it gets
    /// a fresh nonce.
    public func pageWillReload() {
        pageReady = false
        replayCursor = nil
        deferredReady = false
        pageNonce = makeNonce()
    }

    /// Handle a parsed page message. Returns true if the page asked to stop.
    @discardableResult
    public func handle(_ message: WebToNative, nonce: String?, now: TimeInterval) -> Bool {
        if case .ready = message {
            // One handshake per page load: a repeated `ready` from a page that
            // is already connected is ignored (it cannot restart the replay).
            if pageReady { return false }
            if now - lastReadyAt < readyMinInterval {
                deferredReady = true            // honoured on a later tick
            } else {
                acceptReady(now: now)
            }
            return false
        }
        guard pageReady, nonce == pageNonce else { return false }
        switch message {
        case .ready:
            return false
        case .resume(let sid, let from):
            guard let s = current, s.id == sid, replayCursor == nil,
                  now - lastResumeAt >= resumeMinInterval else { return false }
            lastResumeAt = now
            var start = from
            if let oldest = replay.oldestSeq, from < oldest {
                transport?.send(.notice(sessionID: s.id, code: .gap, message: Copy.gapNotice, firstSeq: oldest))
                start = oldest
            }
            replayCursor = start
            stopSent = false
            pump()
            return false
        case .sessionDone(let sid):
            if let s = current, s.id == sid, stopMessage != nil { wipe() }
            return false
        case .stop(let sid):
            guard let s = current, stopMessage == nil else { return false }
            return sid == nil || sid == s.id
        }
    }

    /// The `hello` for this page load did not reach a connected listener
    /// (another script sent `ready` before the web app connected). Forget the
    /// handshake so the web app's own `ready` is honoured at once
    /// (security re-audit N-03).
    public func helloNotDelivered(nonce: String) {
        guard nonce == pageNonce, pageReady else { return }
        pageReady = false
        replayCursor = nil
        stopSent = false
        lastReadyAt = -.infinity
    }

    private func acceptReady(now: TimeInterval) {
        lastReadyAt = now
        deferredReady = false
        pageReady = true
        stopSent = false
        transport?.send(.hello(nonce: pageNonce))
        guard let s = current else { return }
        transport?.send(.sessionStart(s, firstSeq: replay.oldestSeq ?? nextSeq))
        for n in notices { transport?.send(n) }
        replayCursor = replay.oldestSeq ?? nextSeq
        pump()
    }

    /// Sends the next batch of a catch-up, or the stop message once caught up.
    private func pump() {
        guard pageReady, let s = current, let cursor = replayCursor else { return }
        let batch = replay.chunks(fromSeq: cursor).prefix(replayBatch)
        for c in batch {
            transport?.send(.audioChunk(sessionID: s.id, seq: c.seq, data: c.data))
        }
        let next = (batch.last?.seq).map { $0 + 1 } ?? cursor
        if next >= nextSeq {
            replayCursor = nil                  // caught up: back to live
            sendStopIfDue()
        } else {
            replayCursor = next
        }
    }

    private func sendStopIfDue() {
        guard let stop = stopMessage, !stopSent, pageReady, replayCursor == nil else { return }
        stopSent = true
        transport?.send(stop)
    }

    // MARK: Session lifecycle

    public func start(_ info: SessionInfo) {
        wipe()
        current = info
        if pageReady {
            transport?.send(.sessionStart(info, firstSeq: 0))
        }
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
        // While a catch-up runs, live chunks wait for the pump (keeps order).
        if pageReady && replayCursor == nil {
            transport?.send(.audioChunk(sessionID: s.id, seq: seq, data: data))
        }
    }

    public func stop(reason: StopReason, now: TimeInterval) {
        guard let s = current, stopMessage == nil else { return }
        if let tail = chunker.flush() { emit(tail) }
        stopMessage = .sessionStop(sessionID: s.id, reason: reason, lastSeq: nextSeq - 1, totalFrames: totalFrames)
        stoppedAt = now
        stopSent = false
        sendStopIfDue()
    }

    /// Call often (the app calls it every 250 ms and every second). Runs a
    /// deferred `ready`, sends the next catch-up batch, and releases audio
    /// once the keep window has passed.
    public func tick(now: TimeInterval) {
        if deferredReady, now - lastReadyAt >= readyMinInterval { acceptReady(now: now) }
        pump()
        if let t = stoppedAt, now - t >= keepAfterStop { wipe() }
    }

    public var isActive: Bool { current != nil && stopMessage == nil }

    /// Forget the session and release its audio.
    public func wipe() {
        replay.clear()
        current = nil
        stopMessage = nil
        stopSent = false
        stoppedAt = nil
        notices.removeAll()
        chunker = Chunker()
        nextSeq = 0
        totalFrames = 0
        replayCursor = nil
    }
}
