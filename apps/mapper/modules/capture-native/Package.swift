// swift-tools-version: 6.0
// The pure-Swift targets of the capture module, tested with `swift test` (ADR 0007, ADR 0010).
// None imports ARKit, UIKit or simd, so they build on the macOS CI runner and on Linux (CI's
// container step); CaptureCore, Foundation only, builds on Windows too, while CaptureIO needs
// POSIX file I/O (Darwin or Glibc). In the app each is its own pod, and so its own Swift module
// (CaptureCore.podspec and CaptureIO.podspec beside this file); the module's own code is in
// ios/, which only the app build compiles. The podspecs exclude this file and Tests/.
//
// The recorder's code is compiled only under the USG_RECORDER condition, which the app gets only
// in the development and walk builds. Here it is defined by default, so a plain `swift test`
// covers the recorder; `USG_NO_RECORDER=1 swift build` builds without it, as a contributor build
// will, to prove that nothing outside the recorder needs it.
//
// USG_IO_FALLBACKS compiles CaptureIO's pure-Swift SHA-256 and stored-block DEFLATE even where
// CryptoKit and Compression exist, so `swift test` on macOS checks them against the real ones
// (design D17). Only this file defines it: the pods never do, so iOS never compiles them.
//
// USG_SYNTHETIC_EXPORT compiles TarExporter.exportSynthetic, which exports a generated recording
// without a RecordingGrant, for the capture-synth executable (SyntheticSession → RecorderCore →
// FileSink, then the export, for validate-recording in CI). Only this file defines it, so on the
// phone only a grant exports (design section 2).

import PackageDescription

let recorder: [SwiftSetting] =
  Context.environment["USG_NO_RECORDER"] == "1" ? [] : [.define("USG_RECORDER")]

let fallbacks: [SwiftSetting] = [.define("USG_IO_FALLBACKS")]

let syntheticExport: [SwiftSetting] = [.define("USG_SYNTHETIC_EXPORT")]

let package = Package(
  name: "CaptureNative",
  platforms: [.iOS("16.4"), .macOS(.v14)],
  products: [
    .library(name: "CaptureCore", targets: ["CaptureCore"]),
    .library(name: "CaptureIO", targets: ["CaptureIO"]),
  ],
  targets: [
    .target(name: "CaptureCore", path: "Sources/CaptureCore", swiftSettings: recorder),
    // Durable files, hashing, compression, atomic documents, and the recorder's sink, recovery,
    // export and self-test (design 3.2, 7 and 9).
    .target(
      name: "CaptureIO", dependencies: ["CaptureCore"], path: "Sources/CaptureIO",
      swiftSettings: recorder + fallbacks + syntheticExport),
    // A synthetic recording, and its export, written by the real code into --out (design D13).
    .executableTarget(
      name: "capture-synth", dependencies: ["CaptureCore", "CaptureIO"],
      path: "Sources/capture-synth", swiftSettings: recorder),
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
    .testTarget(
      name: "CaptureIOTests",
      dependencies: ["CaptureIO", "CaptureCore"],
      path: "Tests/CaptureIOTests",
      swiftSettings: recorder + fallbacks
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
