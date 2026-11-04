import XCTest
import Foundation
@testable import VaaniCore

final class AudioTests: XCTestCase {
    private func sine(freq: Double, rate: Double, seconds: Double, amp: Float = 0.5) -> [Float] {
        (0..<Int(rate * seconds)).map { amp * Float(sin(2 * Double.pi * freq * Double($0) / rate)) }
    }

    private func rms(_ x: ArraySlice<Float>) -> Float {
        guard !x.isEmpty else { return 0 }
        return (x.reduce(0) { $0 + $1 * $1 } / Float(x.count)).squareRoot()
    }

    /// Zero crossings per second / 2 = frequency.
    private func estimateFrequency(_ x: [Float], rate: Double) -> Double {
        var crossings = 0
        for i in 1..<x.count where (x[i - 1] < 0) != (x[i] < 0) { crossings += 1 }
        return Double(crossings) / 2 / (Double(x.count) / rate)
    }

    // MARK: Resampler

    func testResample48kTo16kKeepsLengthAndPitch() {
        let r = StreamingResampler(inputRate: 48_000)
        let input = sine(freq: 440, rate: 48_000, seconds: 1)
        var out: [Float] = []
        // Feed in odd-sized chunks like a real audio callback.
        var i = 0
        while i < input.count {
            let n = min(441, input.count - i)
            out += r.process(Array(input[i..<(i + n)]))
            i += n
        }
        XCTAssertEqual(Double(out.count), 16_000, accuracy: 3)
        XCTAssertEqual(estimateFrequency(Array(out[1600...]), rate: 16_000), 440, accuracy: 5)
        XCTAssertEqual(rms(out[1600...]), Float(0.5) / Float(2).squareRoot(), accuracy: 0.03)
    }

    func testResample44k1() {
        let r = StreamingResampler(inputRate: 44_100)
        let out = r.process(sine(freq: 1000, rate: 44_100, seconds: 2))
        XCTAssertEqual(Double(out.count), 32_000, accuracy: 3)
        XCTAssertEqual(estimateFrequency(Array(out[3200...]), rate: 16_000), 1000, accuracy: 8)
    }

    func testResamplerRemovesContentAboveNyquist() {
        // 12 kHz cannot exist at 16 kHz; it must be filtered, not aliased to 4 kHz.
        let r = StreamingResampler(inputRate: 48_000)
        let out = r.process(sine(freq: 12_000, rate: 48_000, seconds: 1))
        XCTAssertLessThan(rms(out[1600...]), 0.03)
    }

    func testSameRatePassThrough() {
        let r = StreamingResampler(inputRate: 16_000)
        let x: [Float] = [0.1, -0.2, 0.3]
        XCTAssertEqual(r.process(x), x)
        XCTAssertEqual(r.process([]), [])
    }

    func testDownmix() {
        let interleaved: [Float] = [1, 0, 0.5, 0.5, -1, 1]
        let mono = interleaved.withUnsafeBufferPointer { Downmix.interleavedToMono($0, channels: 2) }
        XCTAssertEqual(mono, [0.5, 0.5, 0])
        XCTAssertEqual(Downmix.planarToMono([[1, 1], [0, -1]]), [0.5, 0])
        XCTAssertEqual(Downmix.planarToMono([[0.25]]), [0.25])
        XCTAssertEqual(Downmix.planarToMono([]), [])
    }

    // MARK: Mixer

    func testMixerSumsAlignedSources() {
        let m = AudioMixer(sources: [.mic, .app])
        m.append(.mic, [0.1, 0.2, 0.3])
        XCTAssertEqual(m.drain(), [], "waits for the other side within the lag window")
        m.append(.app, [0.1, 0.1])
        let out = m.drain()
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out[0], 0.2, accuracy: 1e-6)
        XCTAssertEqual(out[1], 0.3, accuracy: 1e-6)
        let tail = m.drain(flush: true)
        XCTAssertEqual(tail.count, 1)
        XCTAssertEqual(tail[0], 0.3, accuracy: 1e-6)
    }

    func testMixerClipsSum() {
        let m = AudioMixer(sources: [.mic, .app])
        m.append(.mic, [0.9, -0.9])
        m.append(.app, [0.9, -0.9])
        XCTAssertEqual(m.drain(), [1, -1])
    }

    func testMixerDoesNotWaitForeverOnStalledSource() {
        let m = AudioMixer(sources: [.mic, .app], maxLagFrames: 100)
        m.append(.mic, [Float](repeating: 0.5, count: 350))
        let out = m.drain()
        XCTAssertEqual(out.count, 250)  // everything older than the lag window
        XCTAssertTrue(out.allSatisfy { $0 == 0.5 })
    }

    func testMixerSingleSourceAndDeactivate() {
        let m = AudioMixer(sources: [.mic, .app])
        m.deactivate(.app)
        m.append(.app, [1, 1])          // ignored
        m.append(.mic, [0.25, 0.5])
        XCTAssertEqual(m.drain(), [0.25, 0.5])
        XCTAssertEqual(m.activeSources, [.mic])
    }

    func testMixerCapsMemory() {
        let m = AudioMixer(sources: [.mic], maxQueuedFrames: 10)
        m.append(.mic, [Float](repeating: 0.1, count: 25))
        XCTAssertEqual(m.drain().count, 10)
    }

    func testMixerIsThreadSafe() {
        let m = AudioMixer(sources: [.mic, .app])
        let group = DispatchGroup()
        for src in [AudioSourceKind.mic, .app] {
            DispatchQueue.global().async(group: group) {
                for _ in 0..<500 { m.append(src, [Float](repeating: 0.001, count: 160)) }
            }
        }
        // Every input sample must come out exactly once (no loss, no double
        // counting), whatever the interleaving. Values are small, so no clipping.
        final class Sum: @unchecked Sendable { var value: Double = 0 }
        let drained = Sum()
        DispatchQueue.global().async(group: group) {
            for _ in 0..<200 { drained.value += m.drain().reduce(0) { $0 + Double($1) } }
        }
        group.wait()
        let total = drained.value + m.drain(flush: true).reduce(0) { $0 + Double($1) }
        XCTAssertEqual(total, 2 * 500 * 160 * 0.001, accuracy: 0.01)
    }

    // MARK: PCM and chunks

    func testPCM16RoundTripAndClipping() {
        let data = PCM16.encode([0, 1, -1, 0.5, 2, -3, .nan])
        XCTAssertEqual(data.count, 14)
        XCTAssertEqual(PCM16.decode(data), [0, 32767, -32768, 16384, 32767, -32768, 0])
        XCTAssertEqual(Array(data.prefix(4)), [0x00, 0x00, 0xFF, 0x7F], "little-endian")
    }

    func testChunkerCutsQuarterSeconds() {
        var c = Chunker()
        XCTAssertTrue(c.push([Float](repeating: 0, count: 3_999)).isEmpty)
        let chunks = c.push([Float](repeating: 0, count: 8_002))
        XCTAssertEqual(chunks.map(\.count), [4_000, 4_000, 4_000])
        XCTAssertEqual(c.flush()?.count, 1)
        XCTAssertNil(c.flush())
    }

    func testReplayBufferCapAndClear() {
        let r = ReplayBuffer(maxBytes: 10)
        r.append(seq: 0, data: Data(count: 4))
        r.append(seq: 1, data: Data(count: 4))
        r.append(seq: 2, data: Data(count: 4))
        XCTAssertEqual(r.oldestSeq, 1)
        XCTAssertEqual(r.chunks(fromSeq: 2).map(\.seq), [2])
        XCTAssertEqual(r.byteCount, 8)
        r.clear()
        XCTAssertEqual(r.byteCount, 0)
        XCTAssertNil(r.oldestSeq)
    }

    // MARK: Tap planning and health

    func testTapPlanTargetsCallAppAndHelpers() {
        let procs = [
            AudioProcessInfo(objectID: 101, pid: 1, bundleID: "com.google.Chrome", runningInput: false),
            AudioProcessInfo(objectID: 102, pid: 2, bundleID: "com.google.Chrome.helper", runningInput: true, runningOutput: true),
            AudioProcessInfo(objectID: 103, pid: 3, bundleID: "us.zoom.xos", runningInput: false),
            AudioProcessInfo(objectID: 104, pid: 999, bundleID: VaaniIdentity.bundleID, runningInput: true)
        ]
        let chrome = AppCatalog.knownApp(familyID: "chrome")!
        let c = CallCandidate(familyID: "chrome", displayName: "Chrome", kind: .browser, isKnownCallApp: true,
                              bundleID: chrome.bundleIDs.first, pids: [2], priority: 1)
        XCTAssertEqual(TapPlanner.plan(for: c, processes: procs, selfPID: 999, captureAll: false), .processes([101, 102]))
        XCTAssertFalse(TapPlanner.plan(for: c, processes: procs, selfPID: 999, captureAll: false).isSystemWide)
        XCTAssertEqual(TapPlanner.plan(for: c, processes: procs, selfPID: 999, captureAll: true), .systemWideExcluding([104]))
        XCTAssertEqual(TapPlanner.plan(for: nil, processes: procs, selfPID: 999, captureAll: false), .systemWideExcluding([104]))
        let ft = CallCandidate(familyID: "facetime", displayName: "FaceTime", kind: .call, isKnownCallApp: true,
                               bundleID: "com.apple.FaceTime", pids: [5], priority: 2)
        XCTAssertTrue(TapPlanner.plan(for: ft, processes: procs, selfPID: 999, captureAll: false).isSystemWide)
        // App not in the audio list any more: fall back to system-wide.
        let gone = CallCandidate(familyID: "bundle:com.x.y", displayName: "Y", kind: .other, isKnownCallApp: false,
                                 bundleID: "com.x.y", pids: [77], priority: 0)
        XCTAssertTrue(TapPlanner.plan(for: gone, processes: procs, selfPID: 999, captureAll: false).isSystemWide)
    }

    func testTapHealthAsksOnlyWhenNeverHeard() {
        let h = TapHealthMonitor(startedAt: 0, silenceLimit: 10)
        XCTAssertEqual(h.verdict(now: 5, targetPlaying: false, isSystemWide: false), .waiting)
        XCTAssertEqual(h.verdict(now: 6, targetPlaying: true, isSystemWide: false), .waiting)
        XCTAssertEqual(h.verdict(now: 16, targetPlaying: true, isSystemWide: false), .askToWiden)
        XCTAssertEqual(h.verdict(now: 40, targetPlaying: true, isSystemWide: false), .healthy, "asked once")
        // A system-wide tap that never hears anything: permission notice once.
        let w = TapHealthMonitor(startedAt: 100, silenceLimit: 10)
        XCTAssertEqual(w.verdict(now: 105, targetPlaying: true, isSystemWide: true), .waiting)
        XCTAssertEqual(w.verdict(now: 115, targetPlaying: true, isSystemWide: true), .likelyNoPermission)
        XCTAssertEqual(w.verdict(now: 130, targetPlaying: true, isSystemWide: true), .healthy)
    }

    func testTapHealthHappyPath() {
        let h = TapHealthMonitor(startedAt: 0, silenceLimit: 10)
        h.observe(samples: [0, 0, 0.001], now: 2)
        XCTAssertTrue(h.everHeardSound)
        XCTAssertEqual(h.verdict(now: 3, targetPlaying: true, isSystemWide: false), .healthy)
        // Quiet stretch while nobody plays: no escalation.
        XCTAssertEqual(h.verdict(now: 100, targetPlaying: false, isSystemWide: false), .healthy)
        XCTAssertFalse(TapHealthMonitor.hasSound([0, 0, 0]))
    }
}
