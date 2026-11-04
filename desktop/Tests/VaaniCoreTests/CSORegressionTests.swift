// Regression tests for security audit SECURITY-AUDIT-desktop-v1.md.
// Ported from the auditor's probes (cso-desktop/.../CSOProbeTests.swift),
// which passed while each weakness was present. These assert the fix.
import XCTest
import Foundation
@testable import VaaniCore

private let me: Int32 = 999
private func p(_ b: String?, _ pid: Int32, input: Bool = true, output: Bool = false) -> AudioProcessInfo {
    AudioProcessInfo(objectID: UInt32(pid), pid: pid, bundleID: b, runningInput: input, runningOutput: output)
}

private final class CountingTransport: BridgeTransport {
    var chunks = 0, bytes = 0, starts = 0
    var sent: [[String: Any]] = []
    func send(_ m: NativeToWeb) -> Bool {
        switch m {
        case .audioChunk(_, _, let d): chunks += 1; bytes += d.base64EncodedString().utf8.count
        case .sessionStart: starts += 1
        default: break
        }
        sent.append(m.payload)
        return true
    }
}

final class CSORegressionTests: XCTestCase {
    private func det() -> MeetingDetector { MeetingDetector(settings: DetectionSettings(), selfPID: me) }

    private func events(_ d: MeetingDetector, _ procs: [AudioProcessInfo]?, _ r: ClosedRange<Int>,
                        mic: Bool = false) -> [(Int, DetectorEvent)] {
        var out: [(Int, DetectorEvent)] = []
        for t in r {
            for e in d.update(DetectorInput(now: TimeInterval(t), processes: procs, micRunningSomewhere: mic)) {
                out.append((t, e))
            }
        }
        return out
    }

    // H-01, probe A: Meet in Chrome ends, a YouTube tab keeps playing.
    func testH01_A_BrowserCallStopsWhenMicIsReleasedEvenIfTabPlays() {
        let d = det()
        let meet = [p("com.google.Chrome.helper", 10, input: true, output: true)]
        _ = events(d, meet, 0...5)
        guard case .prompting = d.state else { return XCTFail("expected prompt") }
        XCTAssertNotNil(d.userTookNotes(now: 5))
        XCTAssertTrue(events(d, meet, 6...600).isEmpty)
        let youtube = [p("com.google.Chrome.helper", 11, input: false, output: true)]
        let ev = events(d, youtube, 601...(601 + 4 * 3600))
        XCTAssertEqual(ev.count, 1, "exactly one stop")
        XCTAssertEqual(ev.first?.0, 660, "60 s after Chrome let go of the mic at t=600")
        if case .autoStop(.callEnded(let c))? = ev.first?.1 { XCTAssertEqual(c.familyID, "chrome") } else { XCTFail() }
    }

    // H-01: chatty native apps (pings every 30 s) also stop once the mic is released.
    func testH01_ChattyNativeAppStopsWithinGracePlusAutoStop() {
        let d = det()
        _ = events(d, [p("com.tinyspeck.slackmacgap", 20)], 0...3)
        d.userTookNotes(now: 3)
        var stopAt: Int?
        for t in 4...3600 {
            let pinging = t % 30 == 0
            let procs = [p("com.tinyspeck.slackmacgap", 20, input: false, output: pinging)]
            for e in d.update(DetectorInput(now: TimeInterval(t), processes: procs)) {
                if case .autoStop = e { stopAt = stopAt ?? t }
            }
        }
        XCTAssertNotNil(stopAt)
        XCTAssertLessThanOrEqual(stopAt ?? .max, 3 + 300 + 60)
    }

    // H-01, probe B: fallback mode; Vaani's own mic must not keep the call alive.
    func testH01_B_FallbackSessionIsCheckedHourlyAndStopsIfUnanswered() {
        let d = det()
        _ = events(d, nil, 0...25, mic: true)
        guard case .prompting(let c, _) = d.state else { return XCTFail("expected prompt") }
        XCTAssertEqual(c.displayName, "Another app")
        XCTAssertNotNil(d.userTookNotes(now: 25))
        let ev = events(d, nil, 26...7200, mic: true)
        XCTAssertEqual(ev.map(\.1), [.askStillTakingNotes(c), .autoStop(.noAnswer)])
        XCTAssertEqual(ev.map(\.0), [3625, 3745])
    }

    // H-01, probe C: "Take notes now" with no call. Checked hourly, and the
    // tap is system-wide, which the app must say up front (M-01).
    func testH01_C_TakeNotesNowIsCheckedHourly() {
        let d = det()
        d.manualRecordingStarted(now: 0, attachTo: nil)
        let ev = events(d, [], 1...(8 * 3600))
        XCTAssertEqual(ev.map(\.1), [.askStillTakingNotes(nil), .autoStop(.noAnswer)])
        let plan = TapPlanner.plan(for: nil, processes: [p("com.spotify.client", 5, input: false, output: true)],
                                   selfPID: me, captureAll: false)
        XCTAssertTrue(plan.isSystemWide, "still system-wide: the menu item says so before recording")
        XCTAssertEqual(Copy.menuTakeNotesNowAllSound, "Take notes now, with all Mac sound")
    }

    // M-01, probe D: never widen on its own; only ask, and only if never heard.
    func testM01_D_SilentCallNeverWidensAndAsksOnlyIfNeverHeard() {
        let m = TapHealthMonitor(startedAt: 0)
        var verdicts: [TapHealthMonitor.Verdict] = []
        for t in 0...30 {
            m.observe(samples: [0, 0, 0], now: TimeInterval(t))
            verdicts.append(m.verdict(now: TimeInterval(t), targetPlaying: true, isSystemWide: false))
        }
        XCTAssertEqual(verdicts.filter { $0 == .askToWiden }.count, 1, "asks once, does not widen by itself")
        // After real sound was heard, a long silent stretch is just silence.
        let m2 = TapHealthMonitor(startedAt: 0)
        m2.observe(samples: [0.1], now: 0)
        for t in 1...600 {
            m2.observe(samples: [0], now: TimeInterval(t))
            XCTAssertEqual(m2.verdict(now: TimeInterval(t), targetPlaying: true, isSystemWide: false), .healthy)
        }
    }

    // M-01, probe E: a Safari call taps only the WebKit GPU process holding the call's mic.
    func testM01_E_SafariPlanExcludesOtherAppsWebKit() {
        let procs = [p("com.apple.WebKit.GPU", 20, input: true, output: true),   // Safari's, in the call
                     p("com.apple.WebKit.GPU", 21, input: false, output: true),  // Mail's / Vaani's
                     p("com.apple.Safari", 22, input: false, output: false)]
        let c = det().classify(procs[0])!
        XCTAssertEqual(TapPlanner.plan(for: c, processes: procs, selfPID: me, captureAll: false), .processes([20, 22]))
    }

    // M-01: system-wide capture is reported to the page as such.
    func testM01_CaptureModeNamesSystemWide() {
        XCTAssertEqual(CaptureMode.micAndSystem.rawValue, "mic+system")
        let info = SessionInfo(id: "S", startedAt: Date(), appName: "FaceTime", bundleID: nil, kind: .call,
                               capture: .micAndSystem, notice: Copy.systemWideFromStart)
        XCTAssertEqual(NativeToWeb.sessionStart(info, firstSeq: 0).payload["capture"] as? String, "mic+system")
    }

    // L-02, probe F: page messages cannot amplify the replay.
    func testL02_F_ReadyAndResumeSpamIsBounded() {
        let t = CountingTransport()
        let s = BridgeSession(transport: t)
        s.start(SessionInfo(id: "S", startedAt: Date(), appName: "Zoom", bundleID: nil, kind: .meeting, capture: .micAndApp))
        let quarter = [Float](repeating: 0.01, count: 4000)
        for _ in 0..<(4 * 60 * 30) { s.push(quarter) }     // 30 min = 7200 chunks
        for _ in 0..<10 { s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0) }
        for _ in 0..<10 { s.handle(.resume(sessionID: "S", fromSeq: 0), nonce: s.pageNonce, now: 0) }
        XCTAssertEqual(t.chunks, 200, "one batch, not 20 x 7200")
        // Draining the catch-up takes many ticks of at most 200 chunks.
        var ticks = 0
        while s.isReplaying {
            let before = t.chunks
            s.tick(now: 0.25 * Double(ticks + 1))
            XCTAssertLessThanOrEqual(t.chunks - before, 200)
            ticks += 1
        }
        XCTAssertEqual(t.chunks, 7200, "each chunk sent exactly once")
        XCTAssertEqual(t.starts, 1)
    }

    func testL02_ReloadBackoff() {
        var b = ReloadBackoff()
        XCTAssertEqual(b.nextDelay(now: 0), 1)
        XCTAssertEqual(b.nextDelay(now: 2), 5)
        XCTAssertEqual(b.nextDelay(now: 10), 30)
        XCTAssertNil(b.nextDelay(now: 50), "gives up after three crashes")
        XCTAssertEqual(b.nextDelay(now: 500), 1, "starts again after a quiet spell")
    }

    // L-03: a page that loads after the cap dropped early chunks still gets audio.
    func testL03_LatePageGetsFirstSeqAndGapNotice() {
        let t = CountingTransport()
        let s = BridgeSession(transport: t, replay: ReplayBuffer(maxBytes: 8_000 * 3))  // keeps 3 chunks
        s.start(SessionInfo(id: "S", startedAt: Date(), appName: "Zoom", bundleID: nil, kind: .meeting, capture: .micAndApp))
        for _ in 0..<10 { s.push([Float](repeating: 0.01, count: 4000)) }            // seq 0...9, keeps 7...9
        s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        let start = t.sent.first { $0["type"] as? String == "session.start" }
        XCTAssertEqual(start?["firstSeq"] as? Int, 7)
        XCTAssertEqual(t.sent.compactMap { $0["seq"] as? Int }, [7, 8, 9])
        t.sent.removeAll()
        s.handle(.resume(sessionID: "S", fromSeq: 0), nonce: s.pageNonce, now: 10)
        XCTAssertEqual(t.sent.first?["code"] as? String, "gap")
        XCTAssertEqual(t.sent.first?["firstSeq"] as? Int, 7)
        XCTAssertEqual(t.sent.compactMap { $0["seq"] as? Int }, [7, 8, 9])
    }

    // L-04, probe G: the top page cannot be blanked; clicks must be real and recent.
    func testL04_G_Navigation() {
        XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: "about:blank"), isMainFrame: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: "about:srcdoc"), isMainFrame: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: "about:blank"), isMainFrame: false)), .allow)
        let gate = ExternalOpenGate()
        XCTAssertFalse(gate.allows(now: 10, lastClickAt: nil, windowIsKey: true), "scripted click: no mouse event")
        XCTAssertFalse(gate.allows(now: 10, lastClickAt: 8.5, windowIsKey: true), "click too old")
        XCTAssertFalse(gate.allows(now: 10, lastClickAt: 9.8, windowIsKey: false), "window not key")
        XCTAssertTrue(gate.allows(now: 10, lastClickAt: 9.8, windowIsKey: true))
        XCTAssertFalse(gate.allows(now: 10.5, lastClickAt: 10.4, windowIsKey: true), "one open per second")
        XCTAssertTrue(gate.allows(now: 11.2, lastClickAt: 11.1, windowIsKey: true))
        // Everything the probe required to stay blocked still is.
        for s in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "blob:https://pradeep411.github.io/x",
                  "zoommtg://zoom.us/join", "x-apple.systempreferences:com.apple.preference.security",
                  "https://pradeep411.github.io/other/", "https://pradeep411.github.io/vaani/%2e%2e/x",
                  "https://pradeep411.github.io/vaanix/", "https://pradeep411.github.io./vaani/",
                  "https://user@pradeep411.github.io/vaani/", "https://pradeep411.github.io:8443/vaani/",
                  "http://pradeep411.github.io/vaani/"] {
            XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: s), isMainFrame: true)), .cancel, s)
            XCTAssertFalse(NavigationPolicy.isAllowedPage(URL(string: s)), s)
        }
        XCTAssertEqual(NavigationPolicy.decide(NavigationRequest(url: URL(string: "zoommtg://x"), isMainFrame: true, userInitiated: true)), .cancel)
        XCTAssertEqual(NavigationPolicy.decidePopup(URL(string: "file:///Applications/Calculator.app")), .cancel)
    }

    // Probe H: parser (unchanged behaviour, plus nonce format).
    func testH_Parser() {
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "ready", "protocol": 1, "pad": String(repeating: "a", count: 9000)]))
        XCTAssertNil(BridgeParser.parse(["v": 2, "type": "ready", "protocol": 1]))
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "stop", "sessionId": "../x"]))
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "stop", "sessionId": String(repeating: "a", count: 65)]))
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "resume", "sessionId": "S", "fromSeq": -1]))
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "eval", "code": "x"]))
        XCTAssertNil(BridgeParser.parse("not an object"))
        XCTAssertNil(BridgeParser.parse(["v": 1, "type": "stop", "nonce": "<script>"]))
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "stop"])?.message, .stop(sessionID: nil))
        XCTAssertEqual(BridgeParser.parse(["v": 1, "type": "stop", "nonce": "abc-1"])?.nonce, "abc-1")
    }

    // L-05: the page must echo the per-load nonce; the dispatch goes only to
    // the single connected callback.
    func testL05_NonceRequiredAndDispatchUsesConnectedCallback() {
        let t = CountingTransport()
        let s = BridgeSession(transport: t)
        s.start(SessionInfo(id: "S", startedAt: Date(), appName: "Zoom", bundleID: nil, kind: .meeting, capture: .micAndApp))
        s.handle(.ready(protocolVersion: 1), nonce: nil, now: 0)
        XCTAssertEqual(t.sent.first?["nonce"] as? String, s.pageNonce)
        XCTAssertFalse(s.handle(.stop(sessionID: "S"), nonce: nil, now: 1), "a script without the nonce cannot stop")
        XCTAssertTrue(s.handle(.stop(sessionID: "S"), nonce: s.pageNonce, now: 1))
        XCTAssertTrue(NativeToWeb.dispatchScript.contains("_deliver(msg)"))
        XCTAssertFalse(NativeToWeb.dispatchScript.contains("dispatchEvent"), "no window-wide event any more")
    }

    // L-06, probe I: app names are cleaned before they reach the page.
    func testL06_I_AppNameIsCleaned() {
        struct Evil: AppNameResolving {
            func displayName(bundleID: String?, pid: Int32) -> String? {
                "<img src=x onerror=alert(1)>\u{202E}mooZ\u{0007}" + String(repeating: "x", count: 200)
            }
        }
        let d = MeetingDetector(settings: DetectionSettings(), selfPID: me, nameResolver: Evil())
        let c = d.classify(p("com.evil.app\u{202E}", 50))!
        let payload = NativeToWeb.sessionStart(SessionInfo(id: "S", startedAt: Date(), appName: c.displayName,
                                                           bundleID: c.bundleID, kind: c.kind, capture: .micAndApp),
                                               firstSeq: 0).payload
        let source = payload["source"] as? [String: Any]
        let app = source?["app"] as? String ?? ""
        XCTAssertFalse(app.unicodeScalars.contains { $0 == "\u{202E}" || $0 == "\u{0007}" })
        XCTAssertLessThanOrEqual(app.count, 64)
        XCTAssertFalse((source?["bundleId"] as? String ?? "").unicodeScalars.contains("\u{202E}"))
        XCTAssertEqual(SafeText.label("\u{202E}\u{200B} "), nil)
        XCTAssertEqual(SafeText.label("Zoom"), "Zoom")
    }

    // H-01 settings are clamped.
    func testSessionCeilingSettingsAreClamped() {
        var s = DetectionSettings()
        s.maxSessionLength = 10
        s.manualCheckInterval = 99_999
        s.stillThereTimeout = 1
        let c = s.sanitized()
        XCTAssertEqual(c.maxSessionLength, 1800)
        XCTAssertEqual(c.manualCheckInterval, 14400)
        XCTAssertEqual(c.stillThereTimeout, 30)
    }
}
