// swift-tools-version:5.9
//
// Vaani desktop (macOS) - Swift Package.
//
//  VaaniCore   pure Swift (Foundation only). Detection rules, audio mixing,
//              resampling, bridge protocol, URL policy. Builds and tests on
//              macOS and Linux. Keep it free of CoreAudio/AppKit so the
//              Windows phase can reuse it.
//  Vaani       the macOS menu-bar app (AppKit, SwiftUI, CoreAudio, WebKit).
//              Every macOS file is wrapped in `#if os(macOS)`, so on Linux
//              this target compiles to a stub that only prints a message.
//
// Language mode: Swift 5 for all targets (tools 5.9 default, stated below).
// The Mac code is written to also be clean under Swift 6 strict concurrency
// rules where it matters (no @MainActor state touched from @Sendable or C
// callbacks without MainActor.assumeIsolated), but Swift 5 mode is what keeps
// AppKit/WebKit's Objective-C delegate signatures matching on both the
// Xcode 15 and Xcode 16 SDKs.
//
import PackageDescription

let package = Package(
    name: "VaaniDesktop",
    platforms: [
        .macOS("14.2")
    ],
    products: [
        .executable(name: "Vaani", targets: ["Vaani"]),
        .library(name: "VaaniCore", targets: ["VaaniCore"])
    ],
    targets: [
        .target(
            name: "VaaniCore",
            path: "Sources/VaaniCore"
        ),
        .executableTarget(
            name: "Vaani",
            dependencies: ["VaaniCore"],
            path: "Sources/Vaani"
        ),
        .testTarget(
            name: "VaaniCoreTests",
            dependencies: ["VaaniCore"],
            path: "Tests/VaaniCoreTests"
        )
    ],
    swiftLanguageVersions: [.v5]
)
