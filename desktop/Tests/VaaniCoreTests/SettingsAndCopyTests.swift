import XCTest
import Foundation
@testable import VaaniCore

final class SettingsAndCopyTests: XCTestCase {
    func testSettingsRoundTrip() {
        let kv = InMemoryKeyValueStore()
        let store = SettingsStore(store: kv)
        XCTAssertEqual(store.load(), DetectionSettings().sanitized(), "defaults when empty")
        var s = DetectionSettings()
        s.enabled = false
        s.ignoredBundleIDs = ["com.example.app"]
        s.captureAllSystemAudio = true
        store.save(s)
        let loaded = store.load()
        XCTAssertFalse(loaded.enabled)
        XCTAssertTrue(loaded.captureAllSystemAudio)
        XCTAssertTrue(loaded.ignoredBundleIDs.contains("com.example.app"))
        XCTAssertTrue(loaded.ignoredBundleIDs.contains(VaaniIdentity.bundleID), "Vaani can never be un-ignored")
    }

    func testMissingKeysKeepDefaultsAndBadDataIsSafe() {
        let kv = InMemoryKeyValueStore()
        kv.set(#"{"enabled": false}"#.data(using: .utf8), forKey: SettingsStore.key)
        let s = SettingsStore(store: kv).load()
        XCTAssertFalse(s.enabled)
        XCTAssertEqual(s.knownAppDebounce, 3)
        XCTAssertTrue(s.ignoredBundleIDs.contains("com.superduper.superwhisper"))

        kv.set(Data("not json".utf8), forKey: SettingsStore.key)
        XCTAssertTrue(SettingsStore(store: kv).load().enabled)

        kv.set(#"{"knownAppDebounce": -5, "autoStopAfter": 1, "ignoredBundleIDs": ["  a.b ", "A.B", ""]}"#.data(using: .utf8), forKey: SettingsStore.key)
        let c = SettingsStore(store: kv).load()
        XCTAssertEqual(c.knownAppDebounce, 1)
        XCTAssertEqual(c.autoStopAfter, 15)
        XCTAssertEqual(c.ignoredBundleIDs, ["a.b", VaaniIdentity.bundleID])
    }

    /// Hallmark copy rules: no em or en dashes, no exclamation marks, no emoji,
    /// no tracked caps.
    func testCopyRules() {
        for s in Copy.allStatic {
            XCTAssertFalse(s.contains("\u{2014}") || s.contains("\u{2013}"), "dash in: \(s)")
            XCTAssertFalse(s.contains("!"), "exclamation in: \(s)")
            XCTAssertFalse(s.unicodeScalars.contains { $0.properties.isEmojiPresentation }, "emoji in: \(s)")
            XCTAssertNotEqual(s, s.uppercased(), "all caps: \(s)")
            XCTAssertLessThanOrEqual(s.count, 140, "too long: \(s)")
        }
        let c = CallCandidate(familyID: "zoom", displayName: "Zoom", kind: .meeting, isKnownCallApp: true,
                              bundleID: nil, pids: [], priority: 2)
        XCTAssertEqual(Copy.promptAnnouncement(c), "Meeting detected in Zoom. Take notes with Vaani?")
        XCTAssertEqual(Copy.menuRecording("Zoom", minutes: 12), "Taking notes in Zoom, 12 min")
    }
}
