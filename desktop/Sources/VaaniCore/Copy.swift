import Foundation

/// Every word the app shows. Plain, short, no dashes, no exclamation marks,
/// no emoji (checked by CopyTests).
public enum Copy {
    // Prompt
    public static let promptQuestion = "Take notes with Vaani?"
    public static let takeNotes = "Take notes"
    public static let notNow = "Not now"
    public static func takeNotesHint(_ app: String) -> String { "Starts notes for this \(app) call." }
    public static let notNowHint = "Hides this until your next call."
    public static func promptAnnouncement(_ c: CallCandidate) -> String {
        "\(c.kind.headline) in \(c.displayName). Take notes with Vaani?"
    }

    // Menu bar
    public static let menuListening = "Listening for calls"
    public static let menuDetectionOff = "Call detection is off"
    public static func menuRecording(_ app: String?, minutes: Int) -> String {
        let length = minutes < 1 ? "just started" : "\(minutes) min"
        if let app { return "Taking notes in \(app), \(length)" }
        return "Taking notes, \(length)"
    }
    public static let menuStop = "Stop taking notes"
    public static let menuTakeNotesNow = "Take notes now"
    public static let menuOpenVaani = "Open Vaani"
    public static let menuDetect = "Detect calls automatically"
    public static let menuIgnored = "Ignored apps…"
    public static let menuLogin = "Open at login"
    public static let menuQuit = "Quit Vaani"
    public static let statusIdleLabel = "Vaani"
    public static let statusRecordingLabel = "Vaani is taking notes"

    // One-line notices
    public static let micOnlyTapFailed =
        "Recording your mic only. Allow Vaani under System Audio Recording in System Settings to include the other side."
    public static let micOnlyOldMac =
        "Recording your mic only. Hearing the other side needs macOS 14.2 or later."
    public static let tapSilent =
        "Vaani cannot hear the other side yet. If this stays, allow Vaani under System Audio Recording in System Settings."
    public static let micDenied =
        "Vaani needs the microphone. Turn it on in System Settings, Privacy and Security, Microphone."
    public static let pageNotReady =
        "The Vaani web app has not connected yet. Your audio is kept on this Mac until it does."
    public static let openSettings = "Open System Settings"

    // Settings window
    public static let settingsTitle = "Vaani settings"
    public static let ignoredHeading = "Ignored apps"
    public static let ignoredExplainer = "Vaani never asks about these apps, even when they use the microphone."
    public static let addApp = "Add app…"
    public static let remove = "Remove"
    public static let restoreDefaults = "Restore defaults"
    public static let captureAllTitle = "Record all Mac sound"
    public static let captureAllExplainer =
        "Use this if notes miss the other side of a call. Vaani then records every app's sound, not just the call app."
    public static let loginItemFailed =
        "macOS did not allow Vaani to open at login. Try again after moving Vaani to Applications."

    /// All strings that reach the screen, for the copy check.
    public static var allStatic: [String] {
        [promptQuestion, takeNotes, notNow, notNowHint, menuListening, menuDetectionOff, menuStop,
         menuTakeNotesNow, menuOpenVaani, menuDetect, menuIgnored, menuLogin, menuQuit, statusIdleLabel,
         statusRecordingLabel, micOnlyTapFailed, micOnlyOldMac, tapSilent, micDenied, pageNotReady,
         openSettings, settingsTitle, ignoredHeading, ignoredExplainer, addApp, remove, restoreDefaults,
         captureAllTitle, captureAllExplainer, loginItemFailed,
         takeNotesHint("Zoom"), menuRecording("Zoom", minutes: 0), menuRecording(nil, minutes: 12)]
    }
}
