// Regression tests for the security RE-audit (SECURITY-AUDIT-desktop-v1.md,
// "Re-audit"), ported from the auditor's CSOReauditProbes.swift. Probes that
// documented a weakness now assert the fix; the rest are kept as-is.
import XCTest
import Foundation
@testable import VaaniCore

private let me: Int32 = 999
private func p(_ b: String?, _ pid: Int32, input: Bool = true, output: Bool = false) -> AudioProcessInfo {
    AudioProcessInfo(objectID: UInt32(pid), pid: pid, bundleID: b, runningInput: input, runningOutput: output)
}
private final class T: BridgeTransport {
    var chunks = 0, hellos = 0, starts = 0
    var lastHelloNonce: String?
    func send(_ m: NativeToWeb) -> Bool {
        switch m {
        case .audioChunk: chunks += 1
        case .hello(let n): hellos += 1; lastHelloNonce = n
        case .sessionStart: starts += 1
        default: break
        }
        return true
    }
}
private func info(_ id: String = "S") -> SessionInfo {
    SessionInfo(id: id, startedAt: Date(), appName: "Zoom", bundleID: nil, kind: .meeting, capture: .micAndApp)
}

final class CSOReauditRegressionTests: XCTestCase {
    private func run(_ d: MeetingDetector, _ procs: [AudioProcessInfo]?, _ r: ClosedRange<Int>) -> [(Int, DetectorEvent)] {
        var out: [(Int, DetectorEvent)] = []
        for t in r { for e in d.update(DetectorInput(now: TimeInterval(t), processes: procs)) { out.append((t, e)) } }
        return out
    }

    // Kept from the re-audit: original probe A, re-run.
    func testReaudit_A_BrowserStopsAfterCall() {
        let d = MeetingDetector(settings: DetectionSettings(), selfPID: me)
        let meet = [p("com.google.Chrome.helper", 10, input: true, output: true)]
        _ = run(d, meet, 0...5); XCTAssertNotNil(d.userTookNotes(now: 5)); _ = run(d, meet, 6...600)
        let ev = run(d, [p("com.google.Chrome.helper", 11, input: false, output: true)], 601...(601 + 4 * 3600))
        XCTAssertEqual(ev.count, 1); XCTAssertEqual(ev.first?.0, 660)
    }

    // Kept: an app that never releases the mic hits the ceiling.
    func testReaudit_AppHoldsMicForeverHitsCeiling() {
        let d = MeetingDetector(settings: DetectionSettings(), selfPID: me)
        let discord = [p("com.hnc.Discord", 30, input: true, output: true)]
        _ = run(d, discord, 0...3); XCTAssertNotNil(d.userTookNotes(now: 3))
        let ev = run(d, discord, 4...8000)
        XCTAssertEqual(ev.map(\.0), [7203, 7323])
        XCTAssertEqual(ev.last?.1, .autoStop(.noAnswer))
    }

    // Kept: "Keep going" re-arms for one interval; values are clamped.
    func testReaudit_KeepGoingAndClamp() {
        var s = DetectionSettings(); s.maxSessionLength = 10_000_000; s.stillThereTimeout = 1e9
        let c = s.sanitized(); XCTAssertEqual(c.maxSessionLength, 14400); XCTAssertEqual(c.stillThereTimeout, 600)
        let d = MeetingDetector(settings: DetectionSettings(), selfPID: me)
        let zoom = [p("us.zoom.xos", 40, input: true, output: true)]
        _ = run(d, zoom, 0...3); XCTAssertNotNil(d.userTookNotes(now: 3))
        XCTAssertEqual(run(d, zoom, 4...7203).map(\.1).count, 1)
        d.userKeepGoing(now: 7250)
        let ev = run(d, zoom, 7204...(7250 + 7200 + 200))
        XCTAssertEqual(ev.map(\.0), [7250 + 7200, 7250 + 7200 + 120])
    }

    // Kept: M-01 re-run.
    func testReaudit_M01_NoSilentWiden() {
        let m = TapHealthMonitor(startedAt: 0)
        m.observe(samples: [0.2], now: 0)
        for t in 1...600 { XCTAssertEqual(m.verdict(now: TimeInterval(t), targetPlaying: true, isSystemWide: false), .healthy) }
        let n = TapHealthMonitor(startedAt: 0)
        let v = (0...600).map { n.verdict(now: TimeInterval($0), targetPlaying: true, isSystemWide: false) }
        XCTAssertEqual(v.filter { $0 == .askToWiden }.count, 1)
        XCTAssertFalse(v.contains(.likelyNoPermission))
    }

    // Kept and bounded: spam plus 10 reloads 5 s apart. Each reload starts one
    // batched catch-up (accepted residual); a single tick never exceeds a batch.
    func testReaudit_L02_Bounded() {
        let t = T(); let s = BridgeSession(transport: t)
        s.start(info())
        let q = [Float](repeating: 0.01, count: 4000)
        for _ in 0..<7200 { s.push(q) }
        for _ in 0..<10 { s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0) }
        for _ in 0..<10 { s.handle(.resume(sessionID: "S", fromSeq: 0), nonce: s.pageNonce, now: 0) }
        XCTAssertEqual(t.chunks, 200)
        for r in 1...10 { s.pageWillReload(); s.handle(.ready(protocolVersion: 1), nonce: nil, now: TimeInterval(r * 5)) }
        XCTAssertLessThanOrEqual(t.chunks, 200 * 11)
    }

    // N-03 (was testN02_ReadyRace): an early `ready` whose hello reached no
    // listener no longer locks the web app out.
    func testReaudit_N03_ReadyRace() {
        let t = T(); let s = BridgeSession(transport: t)
        s.start(info())
        s.push([Float](repeating: 0.01, count: 8000))
        s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)     // early script, nobody connected
        let firstNonce = try! XCTUnwrap(t.lastHelloNonce)
        s.helloNotDelivered(nonce: firstNonce)                        // dispatch returned false
        XCTAssertFalse(s.pageReady)
        s.handle(.ready(protocolVersion: 1), nonce: nil, now: 1)     // the real web app, 1 s later: not deferred
        XCTAssertEqual(t.hellos, 2, "the web app's own ready is honoured")
        XCTAssertEqual(t.starts, 2)
        XCTAssertTrue(s.pageReady)
        // A stale "not delivered" from before cannot undo the new handshake.
        s.helloNotDelivered(nonce: "something-else")
        XCTAssertTrue(s.pageReady)
    }

    // N-02, native half: stop / resume / session.done without the right nonce are refused.
    func testReaudit_N02_ForgedMessageRejected() {
        let s = BridgeSession(transport: T())
        s.start(info())
        s.push([Float](repeating: 0.01, count: 4000))
        s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        s.stop(reason: .user, now: 1)
        for forged in [nil, "guess", ""] as [String?] {
            s.handle(.sessionDone(sessionID: "S"), nonce: forged, now: 2)
            XCTAssertNotNil(s.current, "session.done with nonce \(String(describing: forged)) refused")
            XCTAssertFalse(s.handle(.stop(sessionID: "S"), nonce: forged, now: 2))
        }
        XCTAssertGreaterThan(s.bufferedBytes, 0)
        s.handle(.sessionDone(sessionID: "S"), nonce: s.pageNonce, now: 3)
        XCTAssertNil(s.current)
    }

    // Kept: nonce and parser.
    func testReaudit_Nonce() {
        let s = BridgeSession(transport: T())
        s.start(info())
        s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        XCTAssertFalse(s.handle(.stop(sessionID: "S"), nonce: "guess", now: 1))
        XCTAssertFalse(s.handle(.stop(sessionID: "S"), nonce: nil, now: 1))
        XCTAssertTrue(s.handle(.stop(sessionID: "S"), nonce: s.pageNonce, now: 1))
        let old = s.pageNonce; s.pageWillReload(); XCTAssertNotEqual(old, s.pageNonce)
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "stop", "nonce": 5]))
    }

    // Kept: navigation.
    func testReaudit_Nav() {
        XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: "about:blank"), isMainFrame: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: "about:srcdoc"), isMainFrame: true)), .cancel)
        let g = ExternalOpenGate()
        XCTAssertFalse(g.allows(now: 5, lastClickAt: 5.5, windowIsKey: true), "click in the future")
        XCTAssertFalse(g.allows(now: 5, lastClickAt: nil, windowIsKey: true))
    }

    // Kept: SafeText.
    func testReaudit_SafeText() {
        XCTAssertEqual(SafeText.label("<img src=x>"), "<img src=x>", "markup is NOT escaped: page must use textContent")
        XCTAssertNil(SafeText.label("\u{2066}\u{2069}\u{FEFF}"))
        XCTAssertEqual(SafeText.label(String(repeating: "é", count: 100))?.count, 64)
        XCTAssertFalse(SafeText.label("Zo\u{0000}om\u{202E}")!.unicodeScalars.contains { $0.value == 0 || $0.value == 0x202E })
    }

    // N-05 (was testSafari's stale-PID variant): a plan that turned
    // system-wide after the pill promised "call app only" asks first.
    func testReaudit_N05_StalePidAsksBeforeAllSound() {
        let procs = [p("com.apple.WebKit.GPU", 20), p("com.apple.WebKit.GPU", 21, input: false, output: true),
                     p("com.apple.Safari", 22, input: false)]
        let c = MeetingDetector(settings: DetectionSettings(), selfPID: me).classify(procs[0])!
        let atPill = TapPlanner.plan(for: c, processes: procs, selfPID: me, captureAll: false)
        XCTAssertEqual(atPill, .processes([20, 22]))
        let promised = CaptureScope(plan: atPill)
        XCTAssertEqual(promised, .callAppOnly)
        // By the time the user taps "Take notes", the GPU process has gone.
        var gone = c; gone.pids = [99]
        let atStart = TapPlanner.plan(for: gone, processes: [procs[1]], selfPID: me, captureAll: false)
        XCTAssertTrue(atStart.isSystemWide)
        XCTAssertEqual(ScopeDecision.decide(promised: promised, planned: atStart), .askBeforeAllSound)
        // Within the promise: proceed.
        XCTAssertEqual(ScopeDecision.decide(promised: .allMacSound, planned: atStart), .proceed)
        XCTAssertEqual(ScopeDecision.decide(promised: .callAppOnly, planned: atPill), .proceed)
        XCTAssertEqual(ScopeDecision.decide(promised: .allMacSound, planned: atPill), .proceed, "narrower is fine")
    }

    // D-01: the diagnostic build is detected, fails safe, and never persists.
    func testReaudit_D01_BuildFlavor() {
        XCTAssertEqual(BuildFlavor.detect(infoFlag: nil, sandboxContainerID: "io.github.pradeep411.vaani.desktop"), .standard)
        XCTAssertEqual(BuildFlavor.detect(infoFlag: true, sandboxContainerID: "x"), .diagnostic)
        XCTAssertEqual(BuildFlavor.detect(infoFlag: "true", sandboxContainerID: "x"), .diagnostic)
        XCTAssertEqual(BuildFlavor.detect(infoFlag: nil, sandboxContainerID: nil), .diagnostic, "no sandbox: diagnostic")
        XCTAssertEqual(BuildFlavor.detect(infoFlag: false, sandboxContainerID: ""), .diagnostic)
        XCTAssertFalse(BuildFlavor.diagnostic.allowsLoginItem)
        XCTAssertFalse(BuildFlavor.diagnostic.persistsWebData)
        XCTAssertTrue(BuildFlavor.standard.allowsLoginItem)
        XCTAssertEqual(BuildFlavor.diagnosticBundleID, "io.github.pradeep411.vaani.desktop.diagnostic")
        XCTAssertNotEqual(BuildFlavor.diagnosticBundleID, VaaniIdentity.bundleID)
        // The diagnostic app never prompts about itself (its ID is under Vaani's ignored prefix).
        XCTAssertTrue(DetectionSettings().isIgnored(bundleID: BuildFlavor.diagnosticBundleID))
        XCTAssertEqual(Copy.diagnosticBanner, "Diagnostic build, sandbox off, not for daily use.")
    }

    // N-04: page mic forced off when not on screen; page unloaded when idle and hidden.
    func testReaudit_N04_WindowPolicy() {
        XCTAssertTrue(NotesWindowPolicy.mustForceMicOff(pageCapturing: true, windowOnScreen: false))
        XCTAssertFalse(NotesWindowPolicy.mustForceMicOff(pageCapturing: true, windowOnScreen: true))
        XCTAssertFalse(NotesWindowPolicy.mustForceMicOff(pageCapturing: false, windowOnScreen: false))
        XCTAssertTrue(NotesWindowPolicy.shouldTearDown(windowOnScreen: false, recording: false, sessionBuffered: false))
        XCTAssertFalse(NotesWindowPolicy.shouldTearDown(windowOnScreen: false, recording: false, sessionBuffered: true))
        XCTAssertFalse(NotesWindowPolicy.shouldTearDown(windowOnScreen: false, recording: true, sessionBuffered: false))
        XCTAssertFalse(NotesWindowPolicy.shouldTearDown(windowOnScreen: true, recording: false, sessionBuffered: false))
        // After the 10-minute keep window the session is released, so a
        // hidden page then qualifies for tear-down.
        let s = BridgeSession(transport: T(), keepAfterStop: 600)
        s.start(info()); s.push([Float](repeating: 0.01, count: 4000)); s.stop(reason: .callEnded, now: 0)
        XCTAssertNotNil(s.current)
        s.tick(now: 600)
        XCTAssertNil(s.current)
        XCTAssertTrue(NotesWindowPolicy.shouldTearDown(windowOnScreen: false, recording: false, sessionBuffered: s.current != nil))
    }

    // F-01: the delivery token is baked into the user script and passed only
    // as a callAsyncJavaScript argument; malformed input keeps the bridge closed.
    func testReaudit_F01_UserScriptTokenBuilder() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Resources/vaani-userscript.js")
        let source = try String(contentsOf: url, encoding: .utf8)
        XCTAssertEqual(source.components(separatedBy: BridgeConfig.deliverTokenPlaceholder).count, 2,
                       "placeholder appears exactly once in the shipped script")
        let token = UserScriptBuilder.makeToken()
        XCTAssertTrue(UserScriptBuilder.isValidToken(token))
        XCTAssertNotEqual(token, UserScriptBuilder.makeToken(), "fresh per web view")
        let built = try XCTUnwrap(UserScriptBuilder.build(source: source, token: token))
        XCTAssertFalse(built.contains(BridgeConfig.deliverTokenPlaceholder))
        XCTAssertTrue(built.contains("'\(token)'"))
        XCTAssertTrue(built.contains("if (token !== deliverToken) return false;"), "_deliver checks the token first")
        // Refused: bad tokens (could break out of the JS string) and bad sources.
        for bad in ["", "short", "ABCDEF0123456789ABCDEF0123456789", "0123456789abcdef0123456789abcde'", String(repeating: "a", count: 65)] {
            XCTAssertNil(UserScriptBuilder.build(source: source, token: bad), bad)
        }
        XCTAssertNil(UserScriptBuilder.build(source: "no placeholder", token: token))
        let twice = BridgeConfig.deliverTokenPlaceholder + BridgeConfig.deliverTokenPlaceholder
        XCTAssertNil(UserScriptBuilder.build(source: twice, token: token))
        // The dispatch script reads the token from its arguments, not from a global.
        XCTAssertTrue(NativeToWeb.dispatchScript.contains("_deliver(msg, token)"))
        XCTAssertFalse(NativeToWeb.dispatchScript.contains(token))
    }
}
