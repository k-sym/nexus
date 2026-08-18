// swift-tools-version: 6.0
import PackageDescription

// NexusCore holds all pure, UI-free client logic (models, networking, NDJSON
// streaming, persistence) so it can be unit-tested headlessly on macOS via
// `swift test` — no iOS Simulator and no tailnet required. The iOS app target
// depends on this package. Keep SwiftUI/UIKit OUT of here.
let package = Package(
    name: "NexusCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14), // lets the package build + test on this Mac headlessly
    ],
    products: [
        .library(name: "NexusCore", targets: ["NexusCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.7.3"),
    ],
    targets: [
        .target(
            name: "NexusCore",
            dependencies: [
                .product(name: "Markdown", package: "swift-markdown"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "NexusCoreTests",
            dependencies: ["NexusCore"],
            resources: [.copy("Fixtures")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
