// swift-tools-version: 6.0
// The pure-Swift targets of the capture module, tested with `swift test` (ADR 0007, ADR 0010).
// None imports ARKit, UIKit or simd, so they build on the macOS CI runner, on Linux (CI's
// container step) and on Windows. In the app each is its own pod, and so its own Swift module
// (CaptureCore.podspec beside this file); the module's own code is in ios/, which only the app
// build compiles. The podspecs exclude this file and Tests/.

import PackageDescription

let package = Package(
  name: "CaptureNative",
  platforms: [.iOS("16.4"), .macOS(.v14)],
  products: [
    .library(name: "CaptureCore", targets: ["CaptureCore"])
  ],
  targets: [
    .target(name: "CaptureCore", path: "Sources/CaptureCore"),
    .testTarget(
      name: "CaptureCoreTests",
      dependencies: ["CaptureCore"],
      path: "Tests/CaptureCoreTests",
      // The golden files: LineEncoderTests reads them through #filePath and
      // packages/contracts/test/swift-goldens.test.ts checks them against the schemas, so they are
      // not bundle resources.
      exclude: ["Golden"]
    ),
  ]
)
