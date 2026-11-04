// Entry point. The real app lives in the macOS-only files next to this one.
#if os(macOS)
import AppKit

// Top-level code is not main-actor isolated in Swift 5 language mode, but it
// does run on the main thread, so assert that and enter the main actor.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)   // menu-bar only (LSUIElement)
    app.run()                             // never returns; keeps `delegate` alive
}
#else
print("Vaani desktop runs on macOS 14.2 or later. This build only checks that the shared code compiles.")
#endif
