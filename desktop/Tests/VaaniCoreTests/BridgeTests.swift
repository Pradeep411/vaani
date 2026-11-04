import XCTest
import Foundation
@testable import VaaniCore

final class BridgeTests: XCTestCase {
    private func u(_ s: String) -> URL? { URL(string: s) }

    // MARK: Allowed page

    func testAllowedPages() {
        for s in ["https://pradeep411.github.io/vaani/",
                  "https://pradeep411.github.io/vaani/?src=desktop",
                  "https://PRADEEP411.GITHUB.IO/vaani/notes.html#x",
                  "https://pradeep411.github.io:443/vaani/",
                  "https://pradeep411.github.io/vaani"] {
            XCTAssertTrue(NavigationPolicy.isAllowedPage(u(s)), s)
        }
    }

    func testRejectedPages() {
        for s in ["http://pradeep411.github.io/vaani/",                 // not https
                  "https://pradeep411.github.io/",                      // wrong path
                  "https://pradeep411.github.io/vaanix/",               // prefix trick
                  "https://pradeep411.github.io/other/vaani/",
                  "https://pradeep411.github.io/vaani/../other/",      // dot segments
                  "https://pradeep411.github.io/vaani/%2e%2e/other/",  // encoded dots
                  "https://pradeep411.github.io/vaani%2f..%2fother/",
                  "https://pradeep411.github.io.evil.com/vaani/",      // look-alike host
                  "https://evil.com/vaani/?u=https://pradeep411.github.io/vaani/",
                  "https://pradeep411.github.io@evil.com/vaani/",      // userinfo trick
                  "https://user@pradeep411.github.io/vaani/",
                  "https://pradeep411.github.io:8443/vaani/",          // other port
                  "https://pradeep411.github.io",
                  "file:///vaani/index.html",
                  "javascript:alert(1)",
                  "data:text/html,hi"] {
            XCTAssertFalse(NavigationPolicy.isAllowedPage(u(s)), s)
        }
        XCTAssertFalse(NavigationPolicy.isAllowedPage(nil))
    }

    // MARK: Navigation decisions

    func testNavigationDecisions() {
        let ok = u("https://pradeep411.github.io/vaani/?src=desktop")
        XCTAssertEqual(NavigationPolicy.decide(.init(url: ok, isMainFrame: true)), .allow)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: ok, isMainFrame: false)), .allow)

        let docs = u("https://docs.sarvam.ai/")!
        XCTAssertEqual(NavigationPolicy.decide(.init(url: docs, isMainFrame: true, userInitiated: true)), .openExternally(docs))
        XCTAssertEqual(NavigationPolicy.decide(.init(url: docs, isMainFrame: true, userInitiated: false)), .cancel,
                       "script redirects to other sites are blocked, not opened")
        XCTAssertEqual(NavigationPolicy.decide(.init(url: docs, isMainFrame: false, userInitiated: true)), .cancel,
                       "other-origin iframes are blocked")
        let mail = u("mailto:someone@example.com")!
        XCTAssertEqual(NavigationPolicy.decide(.init(url: mail, isMainFrame: true, userInitiated: true)), .openExternally(mail))
        XCTAssertEqual(NavigationPolicy.decide(.init(url: u("file:///etc/hosts"), isMainFrame: true, userInitiated: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: u("javascript:alert(1)"), isMainFrame: true, userInitiated: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: u("about:blank"), isMainFrame: false)), .allow)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: u("about:srcdoc"), isMainFrame: false)), .allow)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: u("about:blank"), isMainFrame: true)), .cancel, "top page cannot be blanked")
        XCTAssertEqual(NavigationPolicy.decide(.init(url: u("about:config"), isMainFrame: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: nil, isMainFrame: true)), .cancel)

        // Downloads (notes export) only from our page.
        let blob = u("blob:https://pradeep411.github.io/1234")
        XCTAssertEqual(NavigationPolicy.decide(.init(url: blob, isMainFrame: true, shouldDownload: true, sourceIsAllowed: true)), .download)
        XCTAssertEqual(NavigationPolicy.decide(.init(url: blob, isMainFrame: true, shouldDownload: true, sourceIsAllowed: false)), .cancel)

        XCTAssertEqual(NavigationPolicy.decidePopup(docs), .openExternally(docs))
        XCTAssertEqual(NavigationPolicy.decidePopup(u("blob:https://pradeep411.github.io/1")), .cancel)
        XCTAssertEqual(NavigationPolicy.decidePopup(nil), .cancel)
    }

    // MARK: Gate

    func testGate() {
        let good = FrameOrigin(scheme: "https", host: "pradeep411.github.io", port: 0)
        let page = u("https://pradeep411.github.io/vaani/?src=desktop")
        XCTAssertTrue(BridgeGate.accepts(isMainFrame: true, origin: good, pageURL: page))
        XCTAssertFalse(BridgeGate.accepts(isMainFrame: false, origin: good, pageURL: page), "iframes never")
        XCTAssertFalse(BridgeGate.accepts(isMainFrame: true, origin: FrameOrigin(scheme: "http", host: "pradeep411.github.io", port: 0), pageURL: page))
        XCTAssertFalse(BridgeGate.accepts(isMainFrame: true, origin: FrameOrigin(scheme: "https", host: "evil.github.io", port: 0), pageURL: page))
        XCTAssertFalse(BridgeGate.accepts(isMainFrame: true, origin: FrameOrigin(scheme: "https", host: "pradeep411.github.io", port: 8080), pageURL: page))
        XCTAssertFalse(BridgeGate.accepts(isMainFrame: true, origin: good, pageURL: u("https://pradeep411.github.io/other-repo/")),
                       "same host, other path is a different app")
        XCTAssertTrue(BridgeGate.maySend(to: page))
        XCTAssertFalse(BridgeGate.maySend(to: u("https://example.com/")))
    }

    // MARK: Parsing

    func testParseValidMessages() {
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "ready", "protocol": 1])?.message, .ready(protocolVersion: 1))
        XCTAssertEqual(BridgeParser.parse(["v": 1.0, "type": "ready", "protocol": 2.0])?.message, .ready(protocolVersion: 2))
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "stop"])?.message, .stop(sessionID: nil))
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "stop", "sessionId": "abc-1"])?.message, .stop(sessionID: "abc-1"))
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "session.done", "sessionId": "abc"])?.message, .sessionDone(sessionID: "abc"))
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "resume", "sessionId": "abc", "fromSeq": 7])?.message, .resume(sessionID: "abc", fromSeq: 7))
    }

    func testParseRejectsBadMessages() {
        let bad: [Any] = [
            "ready",
            ["type": "ready", "protocol": 1],                                   // no version
            ["v": 2, "type": "ready", "protocol": 1],                           // wrong version
            ["v": 1, "type": "ready"],                                          // no protocol
            ["v": 1, "type": "ready", "protocol": 0],
            ["v": 1, "type": "eval", "code": "x"],                              // unknown type
            ["v": 1, "type": "session.done"],                                   // no session
            ["v": 1, "type": "session.done", "sessionId": "../../etc"],         // bad id
            ["v": 1, "type": "session.done", "sessionId": String(repeating: "a", count: 65)],
            ["v": 1, "type": "resume", "sessionId": "abc", "fromSeq": -1],
            ["v": 1, "type": "resume", "sessionId": "abc", "fromSeq": 1.5],
            ["v": 1, "type": "stop", "pad": String(repeating: "x", count: 9_000)] // too big
        ]
        for b in bad { XCTAssertNil(BridgeParser.parse(b), "\(b)") }
    }

    // MARK: Outbound payloads

    func testPayloadShapes() throws {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let info = SessionInfo(id: "s1", startedAt: start, appName: "Zoom", bundleID: "us.zoom.xos",
                               kind: .meeting, capture: .micOnly, notice: "Recording your mic only.")
        let p = NativeToWeb.sessionStart(info, firstSeq: 0).payload
        XCTAssertEqual(p["type"] as? String, "session.start")
        XCTAssertEqual(p["v"] as? Int, 1)
        XCTAssertEqual(p["capture"] as? String, "mic-only")
        XCTAssertEqual((p["source"] as? [String: Any])?["app"] as? String, "Zoom")
        XCTAssertEqual((p["audio"] as? [String: Any])?["sampleRate"] as? Int, 16_000)
        XCTAssertEqual((p["audio"] as? [String: Any])?["chunkMs"] as? Int, 250)
        XCTAssertEqual(p["startedAt"] as? String, "2023-11-14T22:13:20.000Z")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(p))

        let chunk = NativeToWeb.audioChunk(sessionID: "s1", seq: 3, data: PCM16.encode([0.5, -0.5])).payload
        XCTAssertEqual(chunk["frames"] as? Int, 2)
        let decoded = Data(base64Encoded: chunk["data"] as! String)!
        XCTAssertEqual(PCM16.decode(decoded), [16384, -16384])

        for m in [NativeToWeb.hello(nonce: "n1"),
                  .notice(sessionID: nil, code: .tapUnavailable, message: "x"),
                  .sessionStop(sessionID: "s1", reason: .callEnded, lastSeq: 3, totalFrames: 16_000)] {
            XCTAssertTrue(JSONSerialization.isValidJSONObject(m.payload))
        }
        XCTAssertEqual(NativeToWeb.sessionStop(sessionID: "s1", reason: .callEnded, lastSeq: 3, totalFrames: 1).payload["reason"] as? String, "call-ended")
        XCTAssertFalse(NativeToWeb.dispatchScript.contains("\\("), "no string interpolation of data into script")
    }

    // MARK: Session handshake

    final class RecordingTransport: BridgeTransport {
        var sent: [[String: Any]] = []
        func send(_ message: NativeToWeb) -> Bool { sent.append(message.payload); return true }
        var types: [String] { sent.compactMap { $0["type"] as? String } }
    }

    private func info(_ id: String = "s1") -> SessionInfo {
        SessionInfo(id: id, startedAt: Date(), appName: "Zoom", bundleID: "us.zoom.xos", kind: .meeting, capture: .micAndApp)
    }

    private func makeSession(_ t: RecordingTransport, keep: TimeInterval = 600, batch: Int = 200) -> BridgeSession {
        var n = 0
        return BridgeSession(transport: t, keepAfterStop: keep, replayBatch: batch, makeNonce: { n += 1; return "nonce-\(n)" })
    }

    func testAudioIsHeldUntilPageIsReadyThenReplayed() {
        let t = RecordingTransport()
        let b = makeSession(t)
        b.start(info())
        b.push([Float](repeating: 0.1, count: 8_000))     // two chunks before page is ready
        XCTAssertTrue(t.sent.isEmpty)
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 1)
        XCTAssertEqual(t.types, ["hello", "session.start", "audio.chunk", "audio.chunk"])
        XCTAssertEqual(t.sent[0]["nonce"] as? String, b.pageNonce)
        XCTAssertEqual(t.sent[1]["firstSeq"] as? Int, 0)
        XCTAssertEqual(t.sent.compactMap { $0["seq"] as? Int }, [0, 1])
        b.push([Float](repeating: 0.1, count: 4_000))     // live
        XCTAssertEqual(t.types.last, "audio.chunk")
        XCTAssertEqual(t.sent.last?["seq"] as? Int, 2)
    }

    func testStopFlushesTailAndReloadReplaysEverything() {
        let t = RecordingTransport()
        let b = makeSession(t)
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        b.start(info())
        b.notice(.tapUnavailable, Copy.micOnlyTapFailed)
        b.push([Float](repeating: 0.1, count: 5_000))
        b.stop(reason: .user, now: 10)
        XCTAssertEqual(t.types, ["hello", "session.start", "capture.notice", "audio.chunk", "audio.chunk", "session.stop"])
        XCTAssertEqual(t.sent.last?["lastSeq"] as? Int, 1)
        XCTAssertEqual(t.sent.last?["totalFrames"] as? Int, 5_000)
        b.push([0.1])                                      // ignored after stop
        // Page reloads: it gets the whole session again, including the stop.
        t.sent.removeAll()
        let oldNonce = b.pageNonce
        b.pageWillReload()
        XCTAssertNotEqual(b.pageNonce, oldNonce, "new nonce per page load")
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 11)
        XCTAssertEqual(t.types, ["hello", "session.start", "capture.notice", "audio.chunk", "audio.chunk", "session.stop"])
        // Resume from a sequence number needs the nonce.
        t.sent.removeAll()
        b.handle(.resume(sessionID: "s1", fromSeq: 1), nonce: oldNonce, now: 12)
        XCTAssertTrue(t.sent.isEmpty, "old nonce refused")
        b.handle(.resume(sessionID: "s1", fromSeq: 1), nonce: b.pageNonce, now: 12)
        XCTAssertEqual(t.types, ["audio.chunk", "session.stop"])
        b.handle(.resume(sessionID: "other", fromSeq: 0), nonce: b.pageNonce, now: 30)
        XCTAssertEqual(t.types.count, 2, "wrong session id ignored")
    }

    func testSessionDoneWipesAudioOnlyAfterStopAndWithNonce() {
        let b = makeSession(RecordingTransport())
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        b.start(info())
        b.push([Float](repeating: 0.1, count: 4_000))
        b.handle(.sessionDone(sessionID: "s1"), nonce: b.pageNonce, now: 1)
        XCTAssertGreaterThan(b.bufferedBytes, 0, "not released while still recording")
        b.stop(reason: .user, now: 2)
        b.handle(.sessionDone(sessionID: "nope"), nonce: b.pageNonce, now: 3)
        b.handle(.sessionDone(sessionID: "s1"), nonce: nil, now: 3)
        b.handle(.sessionDone(sessionID: "s1"), nonce: "forged", now: 3)
        XCTAssertGreaterThan(b.bufferedBytes, 0)
        b.handle(.sessionDone(sessionID: "s1"), nonce: b.pageNonce, now: 3)
        XCTAssertEqual(b.bufferedBytes, 0)
        XCTAssertNil(b.current)
    }

    func testKeepWindowReleasesAudio() {
        let b = makeSession(RecordingTransport())
        b.start(info())
        b.push([Float](repeating: 0.1, count: 4_000))
        b.stop(reason: .callEnded, now: 100)
        b.tick(now: 699)
        XCTAssertGreaterThan(b.bufferedBytes, 0)
        b.tick(now: 700)
        XCTAssertEqual(b.bufferedBytes, 0)
    }

    func testWebStopRequestNeedsNonce() {
        let b = makeSession(RecordingTransport())
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        let n = b.pageNonce
        XCTAssertFalse(b.handle(.stop(sessionID: nil), nonce: n, now: 0), "nothing to stop")
        b.start(info())
        XCTAssertFalse(b.handle(.stop(sessionID: "s1"), nonce: nil, now: 0), "no nonce")
        XCTAssertFalse(b.handle(.stop(sessionID: "other"), nonce: n, now: 0))
        XCTAssertTrue(b.handle(.stop(sessionID: "s1"), nonce: n, now: 0))
        XCTAssertTrue(b.handle(.stop(sessionID: nil), nonce: n, now: 0))
        b.stop(reason: .webRequested, now: 1)
        XCTAssertFalse(b.handle(.stop(sessionID: nil), nonce: n, now: 2), "already stopped")
    }

    func testNewSessionReplacesOld() {
        let t = RecordingTransport()
        let b = makeSession(t)
        b.start(info("a"))
        b.push([Float](repeating: 0.1, count: 4_000))
        b.stop(reason: .user, now: 1)
        b.start(info("b"))
        XCTAssertEqual(b.nextSeq, 0)
        XCTAssertEqual(b.bufferedBytes, 0)
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 2)
        XCTAssertEqual(t.types, ["hello", "session.start"])
        XCTAssertEqual(t.sent.last?["sessionId"] as? String, "b")
    }

    func testReplayIsBatchedAndLiveChunksKeepOrder() {
        let t = RecordingTransport()
        let b = makeSession(t, batch: 3)
        b.start(info())
        b.push([Float](repeating: 0.1, count: 4_000 * 7))  // seq 0...6
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        XCTAssertEqual(t.sent.compactMap { $0["seq"] as? Int }, [0, 1, 2])
        b.push([Float](repeating: 0.1, count: 4_000))      // seq 7 arrives mid-replay
        XCTAssertEqual(t.sent.compactMap { $0["seq"] as? Int }, [0, 1, 2], "live chunk waits for the catch-up")
        b.tick(now: 0.25)
        b.tick(now: 0.5)
        b.tick(now: 0.75)
        XCTAssertEqual(t.sent.compactMap { $0["seq"] as? Int }, Array(0...7))
        XCTAssertFalse(b.isReplaying)
        b.push([Float](repeating: 0.1, count: 4_000))
        XCTAssertEqual(t.sent.last?["seq"] as? Int, 8, "live again")
    }

    func testReadyWithinFiveSecondsIsDeferredNotLost() {
        let t = RecordingTransport()
        let b = makeSession(t)
        b.start(info())
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        b.pageWillReload()
        t.sent.removeAll()
        b.handle(.ready(protocolVersion: 1), nonce: nil, now: 2)
        XCTAssertTrue(t.sent.isEmpty)
        b.tick(now: 4)
        XCTAssertTrue(t.sent.isEmpty)
        b.tick(now: 5)
        XCTAssertEqual(t.types.first, "hello")
    }
}
