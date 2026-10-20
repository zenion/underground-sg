// swift-tools-version: 6.0
// The pure-Swift targets of the capture module, tested with `swift test` (ADR 0007, ADR 0010).
// None imports ARKit, UIKit or simd, so they build on the macOS CI runner, on Linux (CI's
// container step) and on Windows. In the app each is its own pod, and so its own Swift module
// (CaptureCore.podspec beside this file); the module's own code is in ios/, which only the app
// build compiles. The podspecs exclude this file and Tests/.
//
// The recorder's code is compiled only under the USG_RECORDER condition, which the app gets only
// in the development and walk builds. Here it is defined by default, so a plain `swift test`
// covers the recorder; `USG_NO_RECORDER=1 swift build` builds without it, as a contributor build
// will, to prove that nothing outside the recorder needs it.

import PackageDescription

let recorder: [SwiftSetting] =
  Context.environment["USG_NO_RECORDER"] == "1" ? [] : [.define("USG_RECORDER")]

let package = Package(
  name: "CaptureNative",
  platforms: [.iOS("16.4"), .macOS(.v14)],
  products: [
    .library(name: "CaptureCore", targets: ["CaptureCore"])
  ],
  targets: [
    .target(name: "CaptureCore", path: "Sources/CaptureCore", swiftSettings: recorder),
    .testTarget(
      name: "CaptureCoreTests",
      dependencies: ["CaptureCore"],
      path: "Tests/CaptureCoreTests",
      // The golden files: LineEncoderTests reads them through #filePath and
      // packages/contracts/test/swift-goldens.test.ts checks them against the schemas, so they are
      // not bundle resources.
      exclude: ["Golden"],
      swiftSettings: recorder
    ),
    // CaptureCore's public surface as code outside it sees it, without @testable. The probe is a
    // third module that gives members the same names as ones that must stay internal: if
    // CaptureCore ever makes one public, the tests stop compiling ("ambiguous use").
    .target(
      name: "PublicSurfaceProbe", dependencies: ["CaptureCore"], path: "Tests/PublicSurfaceProbe",
      swiftSettings: recorder),
    .testTarget(
      name: "CaptureCorePublicSurfaceTests",
      dependencies: ["CaptureCore", "PublicSurfaceProbe"],
      path: "Tests/CaptureCorePublicSurfaceTests",
      swiftSettings: recorder
    ),
  ]
)
