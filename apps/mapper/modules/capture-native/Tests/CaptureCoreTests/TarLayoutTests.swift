import Foundation
import Testing

@testable import CaptureCore

// The export tar's headers and layout against vectors worked out from the ustar spec (POSIX
// pax, "ustar Interchange Format") and cross-checked with Python's tarfile in USTAR_FORMAT
// (mtime, uid and gid 0, mode 0644, empty names), whose output is cut at the two end blocks:
// tarfile pads to a 10,240-byte record, which this format doesn't.

private let frames = "rec-8f9585da-8554-4b8a-ba4e-0f390ccd3802/frames.jsonl"

private func field(_ header: Data, _ offset: Int, _ length: Int) -> [UInt8] {
  Array(header[offset..<(offset + length)])
}

private func ascii(_ text: String) -> [UInt8] { Array(text.utf8) }

@Suite struct TarHeaderTests {
  @Test func aHeaderHasEveryFieldWhereUstarPutsIt() throws {
    let header = try TarLayout.header(name: frames, size: 1_234_567)
    #expect(header.count == 512)
    #expect(
      field(header, 0, 100) == ascii(frames) + [UInt8](repeating: 0, count: 100 - frames.utf8.count)
    )
    #expect(field(header, 100, 8) == ascii("0000644") + [0])
    #expect(field(header, 108, 8) == ascii("0000000") + [0])
    #expect(field(header, 116, 8) == ascii("0000000") + [0])
    // 1,234,567 is 4553207 in octal.
    #expect(field(header, 124, 12) == ascii("00004553207") + [0])
    #expect(field(header, 136, 12) == ascii("00000000000") + [0])
    #expect(field(header, 156, 1) == ascii("0"))
    #expect(field(header, 157, 100) == [UInt8](repeating: 0, count: 100))
    #expect(field(header, 257, 8) == ascii("ustar") + [0] + ascii("00"))
    // uname, gname, devmajor, devminor and prefix are empty.
    #expect(field(header, 265, 247) == [UInt8](repeating: 0, count: 247))
  }

  @Test func theChecksumIsTheByteSumWithItsFieldAsSpaces() throws {
    let header = try TarLayout.header(name: frames, size: 1_234_567)
    var blanked = [UInt8](header)
    for i in 148..<156 { blanked[i] = 0x20 }
    let sum = blanked.reduce(0) { $0 + Int($1) }
    let octal = String(sum, radix: 8)
    #expect(
      field(header, 148, 8) == ascii(String(repeating: "0", count: 6 - octal.count) + octal) + [
        0, 0x20,
      ])
    // The value Python's tarfile writes for the same header.
    #expect(field(header, 148, 8) == ascii("015733") + [0, 0x20])
    #expect(sha256Hex(header) == "ee139ac1a6e50867c14b78dafd46d3ab1a7309e8e29c291996a730be8c0fd649")
    let small = try TarLayout.header(name: "x", size: 0)
    #expect(field(small, 148, 8) == ascii("006125") + [0, 0x20])
    #expect(sha256Hex(small) == "958a9a6d39024ad28227aca904b892d1afd9cda08371337c67b46dabc8e97f57")
  }

  @Test func aWholeTarMatchesPythonsBytes() throws {
    let events = Data(#"{"detail":null,"kind":"recording_opened","t":2}"#.utf8 + [0x0A])
    let bin = Data((0..<3).flatMap { _ in (0...255).map { UInt8($0) } })
    let files = [
      ("rec-8f9585da-8554-4b8a-ba4e-0f390ccd3802/mesh/history.bin", bin),
      ("rec-8f9585da-8554-4b8a-ba4e-0f390ccd3802/events.jsonl", events),
    ]
    let layout = try TarLayout(files: files.map { ($0.0, Int64($0.1.count)) })
    var tar = Data()
    for entry in layout.entries {
      let data = try #require(files.first { $0.0 == entry.name }?.1)
      #expect(Int64(tar.count) == entry.headerOffset)
      tar.append(try TarLayout.header(name: entry.name, size: entry.size))
      #expect(Int64(tar.count) == entry.dataOffset)
      tar.append(data)
      tar.append(Data(count: TarLayout.paddingBytes(forSize: entry.size)))
    }
    tar.append(Data(count: TarLayout.endBytes))
    #expect(layout.entries.map(\.name).first?.hasSuffix("events.jsonl") == true)
    #expect(Int64(tar.count) == layout.tarBytes)
    #expect(layout.tarBytes == 3584)
    #expect(sha256Hex(tar) == "d02ac8acf399e2547cff96d2d55144f544b4e56de9a7d4689982aad1670480da")
  }
}

@Suite struct TarLayoutTests {
  @Test func theSizeIsHeadersPaddedDataAndTheEndBlocks() throws {
    let layout = try TarLayout(files: [("a", 0), ("b", 1), ("c", 512), ("d", 513)])
    #expect(layout.entries.map(\.headerOffset) == [0, 512, 1536, 2560])
    #expect(layout.tarBytes == 512 + 1024 + 1024 + 1536 + 1024)
    #expect(try TarLayout(files: []).tarBytes == 1024)
    #expect(
      [0, 1, 511, 512, 513].map { TarLayout.paddingBytes(forSize: $0) } == [0, 511, 1, 0, 511])
  }

  @Test func membersAreSortedBytewise() throws {
    let layout = try TarLayout(files: [
      ("rec-x/mesh/history.jsonl", 1), ("rec-x/mesh/history.bin", 1), ("rec-x/Z.jsonl", 1),
      ("rec-x/frames.jsonl", 1), ("capture-y/manifest.json", 1), ("rec-x/mesh-a", 1),
    ])
    #expect(
      layout.entries.map(\.name) == [
        "capture-y/manifest.json", "rec-x/Z.jsonl", "rec-x/frames.jsonl", "rec-x/mesh-a",
        "rec-x/mesh/history.bin", "rec-x/mesh/history.jsonl",
      ])
  }

  @Test func badNamesAndSizesAreRefused() {
    let long = String(repeating: "a", count: 101)
    #expect(throws: TarLayoutError.nameTooLong) { try TarLayout(files: [(long, 1)]) }
    #expect(throws: Never.self) { _ = try TarLayout(files: [(String(long.dropFirst()), 1)]) }
    for name in ["", "/abs", "a/../b", "a//b", "./a", "a/", "a b", "a\\b", "é"] {
      #expect(throws: TarLayoutError.badName, "\(name.utf8.count) bytes") {
        try TarLayout.header(name: name, size: 1)
      }
    }
    #expect(throws: TarLayoutError.duplicateName) {
      try TarLayout(files: [("a", 1), ("b", 2), ("a", 3)])
    }
    #expect(throws: TarLayoutError.fileTooLarge) {
      try TarLayout(files: [("a", TarLayout.maxFileBytes + 1)])
    }
    #expect(throws: TarLayoutError.fileTooLarge) { try TarLayout.header(name: "a", size: -1) }
    #expect(throws: Never.self) {
      _ = try TarLayout.header(name: "a", size: TarLayout.maxFileBytes)
    }
  }
}

@Suite struct PartPlanTests {
  private let mib: Int64 = 1024 * 1024

  @Test func partsAreSixteenMebibytesAndTheLastIsShorter() throws {
    #expect(
      try PartPlan(tarBytes: 1024).parts == [
        ExportPartRange(name: "0000.part", offset: 0, bytes: 1024)
      ])
    #expect(try PartPlan(tarBytes: 16 * mib).parts.count == 1)
    let two = try PartPlan(tarBytes: 16 * mib + 1)
    #expect(
      two.parts == [
        ExportPartRange(name: "0000.part", offset: 0, bytes: 16 * mib),
        ExportPartRange(name: "0001.part", offset: 16 * mib, bytes: 1),
      ])
    let golden = try PartPlan(tarBytes: 17_825_792)
    #expect(golden.parts.map(\.bytes) == [16_777_216, 1_048_576])
  }

  @Test func atMost4096Parts() throws {
    let most = try PartPlan(tarBytes: 4096 * 16 * mib)
    #expect(most.parts.count == 4096)
    #expect(most.parts.last?.name == "4095.part")
    #expect(most.parts.last?.bytes == 16 * mib)
    #expect(throws: PartPlanError.tooManyParts(4097)) {
      try PartPlan(tarBytes: 4096 * 16 * mib + 1)
    }
    #expect(PartPlan.partCount(tarBytes: 64 << 40) == 4_194_304)
  }
}
