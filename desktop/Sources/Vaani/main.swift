// Entry point. The real app lives in the macOS-only files next to this one.
#if os(macOS)
import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)   // menu-bar only (LSUIElement)
app.run()
#else
print("Vaani desktop runs on macOS 14.2 or later. This build only checks that the shared code compiles.")
#endif
