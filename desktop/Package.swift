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
    ]
)
