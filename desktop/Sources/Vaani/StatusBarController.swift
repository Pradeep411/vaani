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
        var openAtLogin: Bool
    }

    var snapshot: () -> Snapshot = { Snapshot(detectionOn: true, recording: false, recordingApp: nil, minutes: 0, notice: nil, openAtLogin: false) }
    var onStop: (() -> Void)?
    var onTakeNotesNow: (() -> Void)?
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
        let symbol = s.recording ? "record.circle.fill" : "waveform"
        let label = s.recording ? Copy.statusRecordingLabel : Copy.statusIdleLabel
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
        image?.isTemplate = !s.recording
        button.image = image
        button.contentTintColor = s.recording ? .systemRed : nil
        button.setAccessibilityLabel(label)
        button.toolTip = label
    }

    // Rebuilt every time it opens, so it is always current.
    nonisolated func menuNeedsUpdate(_ menu: NSMenu) {
        MainActor.assumeIsolated { rebuild(menu) }
    }

    private func rebuild(_ menu: NSMenu) {
        let s = snapshot()
        menu.removeAllItems()

        let status: String
        if s.recording { status = Copy.menuRecording(s.recordingApp, minutes: s.minutes) }
        else { status = s.detectionOn ? Copy.menuListening : Copy.menuDetectionOff }
        menu.addItem(disabled(status))
        if let notice = s.notice {
            let n = disabled(notice)
            n.toolTip = notice
            menu.addItem(n)
            if notice != Copy.pageNotReady {
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
            menu.addItem(action(Copy.menuTakeNotesNow, #selector(takeNotesNow)))
        }
        menu.addItem(action(Copy.menuOpenVaani, #selector(openVaani)))
        menu.addItem(.separator())

        let detect = action(Copy.menuDetect, #selector(toggleDetection))
        detect.state = s.detectionOn ? .on : .off
        menu.addItem(detect)
        menu.addItem(action(Copy.menuIgnored, #selector(showSettings)))
        let login = action(Copy.menuLogin, #selector(toggleLogin))
        login.state = s.openAtLogin ? .on : .off
        menu.addItem(login)
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
    @objc private func takeNotesNow() { onTakeNotesNow?() }
    @objc private func openVaani() { onOpenVaani?() }
    @objc private func toggleDetection() { onToggleDetection?() }
    @objc private func showSettings() { onShowSettings?() }
    @objc private func toggleLogin() { onToggleLogin?() }
    @objc private func openPrivacy() { onOpenPrivacySettings?() }
    @objc private func quit() { NSApp.terminate(nil) }
}
#endif
