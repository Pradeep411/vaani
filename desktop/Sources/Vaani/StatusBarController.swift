// macOS ONLY. Verified by macOS CI (compile) and by eye on a Mac.
//
// Menu-bar icon: waveform when listening, red record dot while taking notes.
#if os(macOS)
import AppKit
import VaaniCore

@MainActor
final class StatusBarController: NSObject, NSMenuDelegate {
    struct Snapshot {
        var detectionOn: Bool
        var recording: Bool
        var recordingApp: String?
        var minutes: Int
        var notice: String?
        /// The notes page itself holds the mic (security audit M-02).
        var pageUsingMic: Bool
        /// "Take notes now" would record all Mac sound (no app-only target).
        var takeNotesNowAllSound: Bool
        var openAtLogin: Bool
        /// No-sandbox diagnostic build (re-audit D-01).
        var diagnostic: Bool
    }

    var snapshot: () -> Snapshot = {
        Snapshot(detectionOn: true, recording: false, recordingApp: nil, minutes: 0, notice: nil,
                 pageUsingMic: false, takeNotesNowAllSound: true, openAtLogin: false, diagnostic: true)
    }
    var onStop: (() -> Void)?
    /// Passes the scope the menu item showed when the menu opened (N-05).
    var onTakeNotesNow: ((CaptureScope) -> Void)?
    /// Defaults to "call app only": if the menu item was never shown with
    /// the all-sound wording, a wider plan at start asks first (re-audit).
    private var menuPromise: CaptureScope = .callAppOnly
    var onOpenVaani: (() -> Void)?
    var onToggleDetection: (() -> Void)?
    var onShowSettings: (() -> Void)?
    var onToggleLogin: (() -> Void)?
    var onOpenPrivacySettings: (() -> Void)?

    private let item: NSStatusItem
    private let menu: NSMenu

    override init() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu = NSMenu()
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        refresh()
    }

    func refresh() {
        let s = snapshot()
        guard let button = item.button else { return }
        let live = s.recording || s.pageUsingMic
        let symbol = live ? "record.circle.fill" : "waveform"
        var label = s.recording ? Copy.statusRecordingLabel : (s.pageUsingMic ? Copy.pageMicInUse : Copy.statusIdleLabel)
        if s.diagnostic { label = Copy.diagnosticBanner + " " + label }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        image?.isTemplate = !live
        button.image = image
        button.contentTintColor = live ? .systemRed : nil
        button.setAccessibilityLabel(label)
        button.toolTip = label
    }

    // Rebuilt every time it opens, so it is always current.
    nonisolated func menuNeedsUpdate(_ menu: NSMenu) {
        MainActor.assumeIsolated { rebuild(menu) }
    }

    private func rebuild(_ menu: NSMenu) {
        let s = snapshot()
        menuPromise = .callAppOnly   // only the item shown below may widen it
        menu.removeAllItems()

        let status: String
        if s.recording { status = Copy.menuRecording(s.recordingApp, minutes: s.minutes) }
        else { status = s.detectionOn ? Copy.menuListening : Copy.menuDetectionOff }
        if s.diagnostic {
            menu.addItem(disabled(Copy.diagnosticBanner))
            menu.addItem(.separator())
        }
        menu.addItem(disabled(status))
        if s.pageUsingMic { menu.addItem(disabled(Copy.pageMicInUse)) }
        if let notice = s.notice {
            let n = disabled(notice)
            n.toolTip = notice
            menu.addItem(n)
            if notice != Copy.pageNotReady, notice != Copy.pageCrashed,
               notice != Copy.micOnlyChosen, notice != Copy.widenedByUser, notice != Copy.systemWideFromStart {
                menu.addItem(action(Copy.openSettings, #selector(openPrivacy)))
            }
        }
        menu.addItem(.separator())

        if s.recording {
            let stop = action(Copy.menuStop, #selector(stop))
            stop.keyEquivalent = "."
            stop.keyEquivalentModifierMask = [.command]
            menu.addItem(stop)
        } else {
            // Say "all Mac sound" before recording when that is what happens (audit M-01).
            menuPromise = s.takeNotesNowAllSound ? .allMacSound : .callAppOnly
            menu.addItem(action(s.takeNotesNowAllSound ? Copy.menuTakeNotesNowAllSound : Copy.menuTakeNotesNow,
                                #selector(takeNotesNow)))
        }
        menu.addItem(action(Copy.menuOpenVaani, #selector(openVaani)))
        menu.addItem(.separator())

        let detect = action(Copy.menuDetect, #selector(toggleDetection))
        detect.state = s.detectionOn ? .on : .off
        menu.addItem(detect)
        menu.addItem(action(Copy.menuIgnored, #selector(showSettings)))
        if s.diagnostic {
            menu.addItem(disabled(Copy.diagnosticLoginOff))
        } else {
            let login = action(Copy.menuLogin, #selector(toggleLogin))
            login.state = s.openAtLogin ? .on : .off
            menu.addItem(login)
        }
        menu.addItem(.separator())
        let quit = action(Copy.menuQuit, #selector(quit))
        quit.keyEquivalent = "q"
        menu.addItem(quit)
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    private func action(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        i.isEnabled = true
        return i
    }

    @objc private func stop() { onStop?() }
    @objc private func takeNotesNow() {
        let promise = menuPromise
        menuPromise = .callAppOnly   // used once
        onTakeNotesNow?(promise)
    }
    @objc private func openVaani() { onOpenVaani?() }
    @objc private func toggleDetection() { onToggleDetection?() }
    @objc private func showSettings() { onShowSettings?() }
    @objc private func toggleLogin() { onToggleLogin?() }
    @objc private func openPrivacy() { onOpenPrivacySettings?() }
    @objc private func quit() { NSApp.terminate(nil) }
}
#endif
