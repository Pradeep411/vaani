// macOS ONLY. Verified by macOS CI (compile) and by eye on a Mac.
//
// The "Meeting detected · Zoom / Take notes with Vaani?" pill. A
// non-activating floating panel at the top centre: it never takes focus from
// the call, shows over full-screen apps, honours Reduce Motion, and announces
// itself to VoiceOver.
#if os(macOS)
import AppKit
import SwiftUI
import VaaniCore

/// Borderless, non-activating. Can become key only when clicked, so the
/// buttons work without the call window losing focus first.
final class PromptPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class PromptController {
    var onTakeNotes: (() -> Void)?
    var onNotNow: (() -> Void)?
    private var panel: PromptPanel?
    private(set) var shownCandidate: CallCandidate?

    func show(_ candidate: CallCandidate) {
        hide(animated: false)
        shownCandidate = candidate

        let view = PillView(
            candidate: candidate,
            icon: Self.icon(for: candidate),
            onTakeNotes: { [weak self] in self?.onTakeNotes?() },
            onNotNow: { [weak self] in self?.onNotNow?() })
        let host = NSHostingView(rootView: view)
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize

        let panel = PromptPanel(contentRect: NSRect(origin: .zero, size: size),
                                styleMask: [.borderless, .nonactivatingPanel],
                                backing: .buffered, defer: false)
        panel.contentView = host
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.worksWhenModal = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.setAccessibilityLabel(candidate.title)

        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }
            ?? NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let target = NSPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 12)
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

        // Reduce Motion: fade only. Otherwise a short 8 pt drop with ease-out
        // (no bounce, transform-like frame move plus opacity).
        panel.setFrameOrigin(reduceMotion ? target : NSPoint(x: target.x, y: target.y + 8))
        panel.alphaValue = 0
        panel.orderFrontRegardless()     // shows without activating Vaani
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = reduceMotion ? 0.12 : 0.22
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
            if !reduceMotion { panel.animator().setFrame(NSRect(origin: target, size: size), display: true) }
        }
        self.panel = panel

        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: Copy.promptAnnouncement(candidate),
            .priority: NSAccessibilityPriorityLevel.high.rawValue
        ])
    }

    func hide(animated: Bool = true) {
        guard let panel else { return }
        self.panel = nil
        shownCandidate = nil
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        guard animated else { panel.orderOut(nil); return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = reduceMotion ? 0.1 : 0.16
            panel.animator().alphaValue = 0
        }, completionHandler: {
            panel.orderOut(nil)
        })
    }

    var isVisible: Bool { panel != nil }

    private static func icon(for c: CallCandidate) -> NSImage? {
        if let id = c.bundleID, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            return NSWorkspace.shared.icon(forFile: url.path)
        }
        if let pid = c.pids.first, let app = NSRunningApplication(processIdentifier: pid) {
            return app.icon
        }
        return nil
    }
}

// MARK: - SwiftUI pill

private struct VisualEffectBackground: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .hudWindow
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

struct PillView: View {
    let candidate: CallCandidate
    let icon: NSImage?
    let onTakeNotes: () -> Void
    let onNotNow: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if let icon {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(Copy.promptQuestion)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .fixedSize()
            .accessibilityElement(children: .combine)

            Spacer(minLength: 16)

            Button(Copy.notNow, action: onNotNow)
                .controlSize(.regular)
                .accessibilityHint(Copy.notNowHint)
            Button(Copy.takeNotes, action: onTakeNotes)
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .keyboardShortcut(.defaultAction)
                .accessibilityHint(Copy.takeNotesHint(candidate.displayName))
        }
        .padding(.leading, 12)
        .padding(.trailing, 10)
        .padding(.vertical, 10)
        .frame(minWidth: 380)
        .fixedSize()
        .background(VisualEffectBackground())
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel(candidate.title)
    }
}
#endif
