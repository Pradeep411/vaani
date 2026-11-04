// macOS ONLY. Verified by macOS CI (compile) and by eye on a Mac.
//
// The pill at the top centre of the screen. Three uses:
//   call detected      "Meeting detected · Zoom"     [Not now] [Take notes]
//   long session       "Still taking notes?"          [Stop]    [Keep going]
//   cannot hear app    "Vaani cannot hear Zoom ..."   [Mic only] [Record all sound]
// A non-activating floating panel: it never takes focus from the call, shows
// over full-screen apps, honours Reduce Motion, and announces itself to
// VoiceOver. No default-button shortcut, so a stray Return cannot start a
// recording (security audit hardening note).
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

enum PillKind: Equatable {
    case callDetected
    case stillTakingNotes
    case askToWiden
}

struct PillContent {
    var kind: PillKind
    var title: String
    var subtitle: String
    var announcement: String
    var icon: NSImage?
    var secondaryLabel: String
    var secondaryHint: String
    var primaryLabel: String
    var primaryHint: String
}

@MainActor
final class PromptController {
    private var panel: PromptPanel?
    private(set) var kind: PillKind?
    private var onPrimary: (() -> Void)?
    private var onSecondary: (() -> Void)?

    func show(_ content: PillContent, primary: @escaping () -> Void, secondary: @escaping () -> Void) {
        hide()
        kind = content.kind
        onPrimary = primary
        onSecondary = secondary

        let relay = MainActorRelay(self)
        let view = PillView(content: content,
                            onPrimary: { MainActor.assumeIsolated { if let o = relay.owner { o.tapPrimary() } } },
                            onSecondary: { MainActor.assumeIsolated { if let o = relay.owner { o.tapSecondary() } } })
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
        panel.setAccessibilityLabel(content.title)

        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
        let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let target = NSRect(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 12,
                            width: size.width, height: size.height)
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

        // Reduce Motion: fade only. Otherwise a short 8 pt drop, ease-out,
        // no bounce.
        panel.setFrame(reduceMotion ? target : target.offsetBy(dx: 0, dy: 8), display: false)
        panel.alphaValue = 0
        panel.orderFrontRegardless()     // shows without activating Vaani
        NSAnimationContext.runAnimationGroup { context in
            context.duration = reduceMotion ? 0.12 : 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
            if !reduceMotion { panel.animator().setFrame(target, display: true) }
        }
        self.panel = panel

        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [
            .announcement: content.announcement,
            .priority: NSAccessibilityPriorityLevel.high.rawValue
        ])
    }

    /// Hides at once (no completion-handler animation: keeps every AppKit
    /// call on the main actor without @Sendable closures).
    func hide() {
        panel?.orderOut(nil)
        panel = nil
        kind = nil
        onPrimary = nil
        onSecondary = nil
    }

    /// Hide only if the pill on screen is of this kind.
    func hide(ifShowing kind: PillKind) {
        if self.kind == kind { hide() }
    }

    var isVisible: Bool { panel != nil }

    private func tapPrimary() {
        let action = onPrimary
        hide()
        action?()
    }

    private func tapSecondary() {
        let action = onSecondary
        hide()
        action?()
    }

    static func icon(forBundleID id: String?, pid: Int32?) -> NSImage? {
        if let id, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            return NSWorkspace.shared.icon(forFile: url.path)
        }
        if let pid, let app = NSRunningApplication(processIdentifier: pid) {
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
    let content: PillContent
    let onPrimary: () -> Void
    let onSecondary: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if let icon = content.icon {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 28, height: 28)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(content.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(content.subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .fixedSize()
            .accessibilityElement(children: .combine)

            Spacer(minLength: 16)

            Button(content.secondaryLabel, action: onSecondary)
                .controlSize(.regular)
                .accessibilityHint(content.secondaryHint)
            Button(content.primaryLabel, action: onPrimary)
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
                .accessibilityHint(content.primaryHint)
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
        .accessibilityLabel(content.title)
    }
}
#endif
