import Foundation

/// Every word the app shows. Plain, short, no dashes, no exclamation marks,
/// no emoji (checked by CopyTests).
public enum Copy {
    // Prompt
    public static let promptQuestion = "Take notes with Vaani?"
    /// Shown instead of promptQuestion when this call would be recorded with
    /// all Mac sound (FaceTime, unknown apps, or the setting is on).
    public static let promptQuestionAllSound = "Take notes? Records your mic and all Mac sound."
    public static let takeNotes = "Take notes"
    public static let notNow = "Not now"
    public static func takeNotesHint(_ app: String) -> String { "Starts notes for this \(app) call." }
    public static let notNowHint = "Hides this until your next call."
    public static func promptAnnouncement(_ c: CallCandidate) -> String {
        "\(c.kind.headline) in \(c.displayName). Take notes with Vaani?"
    }

    // "Still taking notes?" check (long sessions)
    public static let stillTitle = "Still taking notes?"
    public static let stillSubtitle = "Vaani stops in 2 minutes if you do not answer."
    public static let stop = "Stop"
    public static let keepGoing = "Keep going"
    public static let stillAnnouncement = "Vaani is still taking notes. Keep going or stop?"

    // Asking before recording all Mac sound
    public static func widenTitle(_ app: String) -> String { "Vaani cannot hear \(app) directly." }
    public static let widenSubtitle = "Record all Mac sound for this call?"
    public static let micOnly = "Mic only"
    public static let recordAllSound = "Record all sound"
    public static func widenAnnouncement(_ app: String) -> String {
        "Vaani cannot hear \(app) directly. Record all Mac sound for this call, or mic only?"
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
    public static let menuTakeNotesNowAllSound = "Take notes now, with all Mac sound"
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
    public static let systemWideFromStart = "Recording your mic and all Mac sound."
    public static let widenedByUser = "Recording your mic and all Mac sound for this call."
    public static let micOnlyChosen = "Recording your mic only for this call."
    public static let micOnlyUntilChosen = "Recording your mic only until you choose."
    public static let gapNotice = "The start of this call is no longer kept on this Mac. Notes cover the rest."
    public static let pageMicInUse = "The Vaani notes window is using your microphone."
    public static let pageCrashed = "The notes window stopped working. Choose Open Vaani to try again."
    public static let windowTitle = "Vaani"
    // Diagnostic (no-sandbox) build only (security re-audit D-01)
    public static let diagnosticBanner = "Diagnostic build, sandbox off, not for daily use."
    public static let diagnosticWindowTitle = "Vaani DIAGNOSTIC: sandbox off, test only"
    public static let diagnosticLoginOff = "Open at login is off in the diagnostic build."
    public static let windowTitleRecording = "Vaani, taking notes"

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
         promptQuestionAllSound, stillTitle, stillSubtitle, stop, keepGoing, stillAnnouncement,
         widenTitle("Zoom"), widenSubtitle, micOnly, recordAllSound, widenAnnouncement("Zoom"),
         menuTakeNotesNowAllSound, systemWideFromStart, widenedByUser, micOnlyChosen, gapNotice,
         pageMicInUse, pageCrashed, windowTitle, windowTitleRecording,
         diagnosticBanner, diagnosticWindowTitle, diagnosticLoginOff, micOnlyUntilChosen,
         takeNotesHint("Zoom"), menuRecording("Zoom", minutes: 0), menuRecording(nil, minutes: 12)]
    }
}
