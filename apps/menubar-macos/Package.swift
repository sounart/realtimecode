// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RealtimeCodeMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "RealtimeCodeMenuBar",
            path: "RealtimeCodeMenuBar"
        )
    ]
)
