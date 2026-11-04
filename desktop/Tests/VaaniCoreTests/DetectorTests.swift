import XCTest
@testable import VaaniCore

private let selfPID: Int32 = 999

private func proc(_ bundle: String?, pid: Int32, input: Bool = true, output: Bool = false, obj: UInt32 = 0) -> AudioProcessInfo {
    AudioProcessInfo(objectID: obj == 0 ? UInt32(pid) : obj, pid: pid, bundleID: bundle, runningInput: input, runningOutput: output)
}

private struct FixedNames: AppNameResolving {
    func displayName(bundleID: String?, pid: Int32) -> String? {
        bundleID == "com.example.Recorder" ? "Recorder Pro" : nil
    }
}

final class DetectorTests: XCTestCase {
    private func makeDetector(_ tweak: (inout DetectionSettings) -> Void = { _ in }) -> MeetingDetector {
        var s = DetectionSettings()
        tweak(&s)
        return MeetingDetector(settings: s, selfPID: selfPID, nameResolver: FixedNames())
    }

    /// Runs the detector once a second from `from` to `to` (inclusive) with
    /// the same process list, collecting events with their times.
    @discardableResult
    private func run(_ d: MeetingDetector, _ procs: [AudioProcessInfo]?, from: Int, to: Int,
                     webCapturing: Bool = false, micSomewhere: Bool = false) -> [(Int, DetectorEvent)] {
        var out: [(Int, DetectorEvent)] = []
        guard from <= to else { return out }
        for t in from...to {
            for e in d.update(DetectorInput(now: TimeInterval(t), processes: procs,
                                            micRunningSomewhere: micSomewhere, selfWebViewCapturing: webCapturing)) {
                out.append((t, e))
            }
        }
        return out
    }

    private func firstPrompt(_ events: [(Int, DetectorEvent)]) -> (Int, CallCandidate)? {
        for (t, e) in events { if case .showPrompt(let c) = e { return (t, c) } }
        return nil
    }

    // MARK: Debounce

    func testKnownCallAppPromptsAfterThreeSeconds() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        XCTAssertNil(firstPrompt(run(d, zoom, from: 0, to: 2)))
        let p = firstPrompt(run(d, zoom, from: 3, to: 3))
        XCTAssertEqual(p?.0, 3)
        XCTAssertEqual(p?.1.title, "Meeting detected · Zoom")
    }

    func testOtherAppNeedsTwentySeconds() {
        let d = makeDetector()
        let other = [proc("com.example.Recorder", pid: 11)]
        XCTAssertNil(firstPrompt(run(d, other, from: 0, to: 19)))
        let p = firstPrompt(run(d, other, from: 20, to: 20))
        XCTAssertEqual(p?.1.displayName, "Recorder Pro")
        XCTAssertEqual(p?.1.title, "Meeting detected · Recorder Pro")
        XCTAssertFalse(p?.1.isKnownCallApp ?? true)
    }

    func testShortMicBlipNeverPrompts() {
        let d = makeDetector()
        run(d, [proc("us.zoom.xos", pid: 10)], from: 0, to: 1)
        let ev = run(d, [], from: 2, to: 40)
        XCTAssertNil(firstPrompt(ev))
    }

    func testOutputOnlyDoesNotPrompt() {
        let d = makeDetector()
        let ev = run(d, [proc("us.zoom.xos", pid: 10, input: false, output: true)], from: 0, to: 30)
        XCTAssertNil(firstPrompt(ev))
    }

    // MARK: Naming

    func testAppNamesAndHeadlines() {
        let d = makeDetector()
        let cases: [(String, String)] = [
            ("us.zoom.xos", "Meeting detected · Zoom"),
            ("com.microsoft.teams2", "Meeting detected · Microsoft Teams"),
            ("com.microsoft.teams", "Meeting detected · Microsoft Teams"),
            ("net.whatsapp.WhatsApp", "Call detected · WhatsApp"),
            ("com.apple.FaceTime", "Call detected · FaceTime"),
            ("com.tinyspeck.slackmacgap", "Huddle detected · Slack"),
            ("com.tinyspeck.slackmacgap.helper", "Huddle detected · Slack"),
            ("Cisco-Systems.Spark", "Meeting detected · Webex"),
            ("com.google.Chrome.helper", "Meeting detected · Chrome"),
            ("com.google.Chrome", "Meeting detected · Chrome"),
            ("com.apple.WebKit.GPU", "Meeting detected · Safari"),
            ("company.thebrowser.Browser", "Meeting detected · Arc"),
            ("com.microsoft.edgemac", "Meeting detected · Edge"),
            ("com.brave.Browser.helper", "Meeting detected · Brave"),
            ("org.mozilla.firefox", "Meeting detected · Firefox")
        ]
        for (bundle, title) in cases {
            XCTAssertEqual(d.classify(proc(bundle, pid: 5))?.title, title, bundle)
        }
        // Prefix rule does not over-match.
        XCTAssertNil(AppCatalog.knownApp(forBundleID: "com.google.Chromecast"))
        XCTAssertNil(AppCatalog.knownApp(forBundleID: "us.zoom.xosfake"))
        // Unknown app without a resolver name falls back to the bundle tail.
        XCTAssertEqual(d.classify(proc("com.acme.CallBox", pid: 6))?.displayName, "CallBox")
        XCTAssertEqual(d.classify(proc(nil, pid: 7))?.displayName, "Another app")
    }

    // MARK: Ignore list

    func testDefaultIgnoreListAndSelf() {
        let d = makeDetector()
        for b in ["com.electron.wispr-flow", "com.superduper.superwhisper", "com.apple.VoiceMemos",
                  "com.apple.DictationIM", "com.apple.corespeechd", "com.apple.Siri", VaaniIdentity.bundleID] {
            XCTAssertNil(d.classify(proc(b, pid: 20)), b)
        }
        XCTAssertNil(d.classify(proc("us.zoom.xos", pid: selfPID)), "own process is never a call")
        let ev = run(d, [proc("com.superduper.superwhisper", pid: 21)], from: 0, to: 100)
        XCTAssertNil(firstPrompt(ev))
    }

    func testUserEditedIgnoreList() {
        let d = makeDetector { $0.ignoredBundleIDs.append("us.zoom.xos") }
        XCTAssertNil(firstPrompt(run(d, [proc("us.zoom.xos", pid: 10)], from: 0, to: 30)))
        // Case-insensitive and dotted-prefix.
        var s = DetectionSettings()
        s.ignoredBundleIDs = ["COM.EXAMPLE"]
        XCTAssertTrue(s.isIgnored(bundleID: "com.example.tool"))
        XCTAssertFalse(s.isIgnored(bundleID: "com.examples.tool"))
        XCTAssertFalse(s.isIgnored(bundleID: nil))
    }

    // MARK: Suppression

    func testNotNowSuppressesThisCallOnly() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        XCTAssertNotNil(firstPrompt(run(d, zoom, from: 0, to: 3)))
        d.userSaidNotNow()
        XCTAssertEqual(d.state, .idle)
        // Same call keeps going: no new prompt.
        XCTAssertNil(firstPrompt(run(d, zoom, from: 4, to: 200)))
        // Short mute-like gap (under newCallGap) is still the same call.
        run(d, [], from: 201, to: 205)
        XCTAssertNil(firstPrompt(run(d, zoom, from: 206, to: 220)))
        // Call ends, a new call starts later: prompt again.
        run(d, [], from: 221, to: 260)
        let p = firstPrompt(run(d, zoom, from: 261, to: 270))
        XCTAssertEqual(p?.0, 264)
    }

    func testNoPromptWhileRecordingAndCooldownAfter() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        let chrome = [proc("com.google.Chrome.helper", pid: 30)]
        run(d, zoom, from: 0, to: 3)
        XCTAssertEqual(d.userTookNotes(now: 3)?.familyID, "zoom")
        XCTAssertTrue(d.isRecording)
        // Another call app shows up while recording: no prompt.
        XCTAssertNil(firstPrompt(run(d, zoom + chrome, from: 4, to: 60)))
        d.recordingEnded(now: 61)
        // Cooldown (60 s): nothing, even though Chrome is still on the mic.
        XCTAssertNil(firstPrompt(run(d, chrome, from: 61, to: 120)))
        // After cooldown, Chrome's ongoing call prompts. Zoom's does not.
        let p = firstPrompt(run(d, chrome + zoom, from: 121, to: 125))
        XCTAssertEqual(p?.1.familyID, "chrome")
    }

    func testStoppingMidCallDoesNotRePromptSameCall() {
        let d = makeDetector { $0.cooldownAfterRecording = 0 }
        let zoom = [proc("us.zoom.xos", pid: 10)]
        run(d, zoom, from: 0, to: 3)
        d.userTookNotes(now: 3)
        XCTAssertTrue(run(d, zoom, from: 4, to: 29).isEmpty)
        d.recordingEnded(now: 30)
        XCTAssertNil(firstPrompt(run(d, zoom, from: 30, to: 300)))
    }

    func testWebViewDictationSuppresses() {
        let d = makeDetector()
        let ev = run(d, [proc("com.apple.WebKit.GPU", pid: 40)], from: 0, to: 30, webCapturing: true)
        XCTAssertNil(firstPrompt(ev))
    }

    func testDetectionOffHidesAndBlocks() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        run(d, zoom, from: 0, to: 3)
        d.settings.enabled = false
        let ev = run(d, zoom, from: 4, to: 4)
        XCTAssertEqual(ev.first?.1, .hidePrompt(.detectionTurnedOff))
        XCTAssertNil(firstPrompt(run(d, zoom, from: 5, to: 100)))
    }

    // MARK: Prompt lifetime

    func testPromptHidesWhenCallEnds() {
        let d = makeDetector()
        run(d, [proc("net.whatsapp.WhatsApp", pid: 12)], from: 0, to: 3)
        let ev = run(d, [], from: 4, to: 12)
        XCTAssertEqual(ev.map(\.1), [.hidePrompt(.callEnded)])
        XCTAssertEqual(ev.first?.0, 8) // 5 s grace after last mic use at t=3
        XCTAssertEqual(d.state, .idle)
    }

    func testUnansweredPromptTimesOutAsNotNow() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        run(d, zoom, from: 0, to: 3)
        let ev = run(d, zoom, from: 4, to: 63)
        XCTAssertEqual(ev.map(\.1), [.hidePrompt(.timedOut)])
        XCTAssertNil(firstPrompt(run(d, zoom, from: 64, to: 200)))
    }

    func testNativeAppOutranksBrowser() {
        let d = makeDetector()
        let ev = run(d, [proc("com.google.Chrome.helper", pid: 30), proc("us.zoom.xos", pid: 10)], from: 0, to: 3)
        XCTAssertEqual(firstPrompt(ev)?.1.familyID, "zoom")
    }

    func testHelpersOfOneAppAreOneCall() {
        let d = makeDetector()
        let ev = run(d, [proc("com.google.Chrome.helper", pid: 30), proc("com.google.Chrome", pid: 31)], from: 0, to: 3)
        let c = firstPrompt(ev)?.1
        XCTAssertEqual(c?.familyID, "chrome")
        XCTAssertEqual(Set(c?.pids ?? []), [30, 31])
    }

    // MARK: Auto-stop

    func testAutoStopSixtySecondsAfterAppGoesQuiet() {
        let d = makeDetector()
        let teams = [proc("com.microsoft.teams2", pid: 50)]
        run(d, teams, from: 0, to: 3)
        d.userTookNotes(now: 3)
        XCTAssertTrue(run(d, teams, from: 4, to: 100).isEmpty)
        let ev = run(d, [], from: 101, to: 200)
        XCTAssertEqual(ev.count, 1)
        XCTAssertEqual(ev.first?.0, 160) // last alive at 100
        if case .autoStop(.callEnded(let c))? = ev.first?.1 { XCTAssertEqual(c.familyID, "teams") } else { XCTFail() }
    }

    func testMutedUserWithMicOpenIsNeverAutoStopped() {
        // Zoom, Teams and Meet keep the mic device open while you are muted.
        let d = makeDetector()
        run(d, [proc("us.zoom.xos", pid: 10)], from: 0, to: 3)
        d.userTookNotes(now: 3)
        let ev = run(d, [proc("us.zoom.xos", pid: 10, input: true, output: true)], from: 4, to: 7000)
        XCTAssertTrue(ev.isEmpty)
    }

    func testNativeAppSoundCountsOnlyFiveMinutesAfterLastMicUse() {
        let d = makeDetector()
        run(d, [proc("us.zoom.xos", pid: 10)], from: 0, to: 3)
        d.userTookNotes(now: 3)
        // Zoom closes the mic but keeps playing sound: grace is 300 s after
        // the last mic use (t=3), then 60 s of auto-stop.
        let ev = run(d, [proc("us.zoom.xos", pid: 10, input: false, output: true)], from: 4, to: 1000)
        XCTAssertEqual(ev.count, 1)
        XCTAssertEqual(ev.first?.0, 363)
    }

    func testAutoStopResetsIfCallComesBack() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        run(d, zoom, from: 0, to: 3)
        d.userTookNotes(now: 3)
        run(d, [], from: 4, to: 50)
        XCTAssertTrue(run(d, zoom, from: 51, to: 60).isEmpty)
        let ev = run(d, [], from: 61, to: 130)
        XCTAssertEqual(ev.first?.0, 120)
    }

    func testAutoStopFiresOnce() {
        let d = makeDetector()
        run(d, [proc("us.zoom.xos", pid: 10)], from: 0, to: 3)
        d.userTookNotes(now: 3)
        let ev = run(d, [], from: 4, to: 400)
        XCTAssertEqual(ev.count, 1)
    }

    func testManualRecordingAsksEveryHourAndStopsIfUnanswered() {
        let d = makeDetector()
        d.manualRecordingStarted(now: 0)
        var ev = run(d, [], from: 1, to: 3600)
        XCTAssertEqual(ev.map(\.1), [.askStillTakingNotes(nil)])
        XCTAssertEqual(ev.first?.0, 3600)
        d.userKeepGoing(now: 3650)
        ev = run(d, [], from: 3651, to: 7249)
        XCTAssertTrue(ev.isEmpty)
        ev = run(d, [], from: 7250, to: 7400)
        XCTAssertEqual(ev.map(\.1), [.askStillTakingNotes(nil), .autoStop(.noAnswer)])
        XCTAssertEqual(ev.map(\.0), [7250, 7370])
    }

    func testCallSessionAsksAfterTwoHours() {
        let d = makeDetector()
        let zoom = [proc("us.zoom.xos", pid: 10)]
        run(d, zoom, from: 0, to: 3)
        d.userTookNotes(now: 3)
        let ev = run(d, zoom, from: 4, to: 7400)
        XCTAssertEqual(ev.count, 2)
        XCTAssertEqual(ev.first?.0, 7203)
        if case .askStillTakingNotes(let c)? = ev.first?.1 { XCTAssertEqual(c?.familyID, "zoom") } else { XCTFail() }
        XCTAssertEqual(ev.last?.1, .autoStop(.noAnswer))
        XCTAssertEqual(ev.last?.0, 7323)
    }

    // MARK: Fallback

    func testFallbackWhenPerProcessDataMissing() {
        let d = makeDetector()
        XCTAssertNil(firstPrompt(run(d, nil, from: 0, to: 19, micSomewhere: true)))
        let p = firstPrompt(run(d, nil, from: 20, to: 20, micSomewhere: true))
        XCTAssertEqual(p?.1.title, "Meeting detected · Another app")
    }

    // MARK: Loop with a fake source

    func testDetectionLoopWithFakeSource() {
        final class FakeSource: AudioProcessSource {
            var procs: [AudioProcessInfo]? = []
            func currentProcesses() -> [AudioProcessInfo]? { procs }
            func isMicRunningSomewhere() -> Bool { false }
        }
        var t: TimeInterval = 0
        let src = FakeSource()
        let loop = DetectionLoop(source: src, detector: makeDetector(), clock: { t })
        src.procs = [proc("us.zoom.xos", pid: 10, output: true)]
        var shown: CallCandidate?
        for i in 0...3 {
            t = TimeInterval(i)
            for e in loop.tick() { if case .showPrompt(let c) = e { shown = c } }
        }
        XCTAssertEqual(shown?.displayName, "Zoom")
        XCTAssertTrue(loop.isPlaying(familyOf: shown))
        XCTAssertEqual(loop.detector.currentLiveCall()?.familyID, "zoom")
    }
}
