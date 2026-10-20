import Foundation
import Testing

@testable import CaptureCore

/// Synthetic 1 Hz fixes on the street at Esplanade MRT Exit F. Positions are metre offsets from
/// the street door, turned into WGS84 here so the tests never reason in degrees.
private let doorLat = 1.2934
private let doorLon = 103.8557

private func fix(t: Double, east: Double = 0, north: Double = 0, accuracy: Double = 8) -> GnssFix {
  let lat = doorLat + north / earthRadiusM * 180 / Double.pi
  let lon = doorLon + east / (earthRadiusM * cos(doorLat * Double.pi / 180)) * 180 / Double.pi
  return GnssFix(t: t, lat: lat, lon: lon, horizontalAccuracyM: accuracy)
}

/// Adds fixes at whole seconds `times`, from `position(t)`, and returns everything written.
private func feed(
  _ windows: inout GnssWindows, _ times: ClosedRange<Int>,
  position: (Double) -> (east: Double, north: Double) = { _ in (0, 0) }
) -> [GnssFix] {
  var out: [GnssFix] = []
  for second in times {
    let t = Double(second)
    let p = position(t)
    out += windows.add(fix(t: t, east: p.east, north: p.north))
  }
  return out
}

private func times(_ fixes: [GnssFix]) -> [Double] { fixes.map(\.t) }

private func seconds(_ range: ClosedRange<Int>) -> [Double] { range.map(Double.init) }

@Suite struct GnssWindowsTests {
  @Test func haversineIsInMetres() {
    let door = fix(t: 0)
    let north = fix(t: 0, north: 100)
    let east = fix(t: 0, east: 80)
    #expect(abs(haversineMetres(door.lat, door.lon, north.lat, north.lon) - 100) < 0.01)
    #expect(abs(haversineMetres(door.lat, door.lon, east.lat, east.lon) - 80) < 0.01)
    #expect(haversineMetres(door.lat, door.lon, door.lat, door.lon) == 0)
  }

  @Test func walkToAStreetDoor() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    // Walking west along the street at 1.4 m/s, reaching the door at 60 s.
    let walk: (Double) -> (east: Double, north: Double) = { t in (max(0, 1.4 * (60 - t)), 0) }
    #expect(feed(&windows, 0...60, position: walk).isEmpty)
    // Marked just after the 60 s fix: the window is [30.5, 90.5], and its reference is the 61 s
    // fix, which hasn't come yet.
    #expect(windows.markStreetAnchor(at: 60.5).isEmpty)
    let atReference = windows.add(fix(t: 61))
    #expect(times(atReference) == seconds(31...61))
    // Standing at the door until the walker goes down at 75 s; fixes stop there.
    let after = feed(&windows, 62...75, position: walk)
    #expect(times(after) == seconds(62...75))
    #expect(atReference.first == fix(t: 31, east: 1.4 * 29))
  }

  @Test func aMarkMidSessionTakesBufferedFixes() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    #expect(feed(&windows, 0...100).isEmpty)
    // The 100 s fix is at the mark, so it is the reference and the window fills at once.
    #expect(times(windows.markStreetAnchor(at: 100)) == seconds(70...100))
    #expect(times(feed(&windows, 101...140)) == seconds(101...130))
    #expect(windows.openWindowCount == 0)
  }

  @Test func nothingFromBeforeTheRecordingOpened() {
    var windows = GnssWindows()
    #expect(feed(&windows, 0...40).isEmpty)
    windows.recordingOpened(at: 30)
    // A later call doesn't move the start.
    windows.recordingOpened(at: 0)
    #expect(windows.markStreetAnchor(at: 40.5).isEmpty)
    #expect(times(windows.add(fix(t: 41))) == seconds(30...41))
  }

  @Test func aStartAnchorMarkedJustBeforeTheRecordingOpens() {
    // A street-facing start anchor: the mark and the recording's opening share t = 100, and the
    // module happens to mark first, with the 100.2 s fix already buffered.
    var windows = GnssWindows()
    #expect(windows.add(fix(t: 99)).isEmpty)
    #expect(windows.add(fix(t: 100.2)).isEmpty)
    #expect(windows.markStreetAnchor(at: 100).isEmpty)
    windows.recordingOpened(at: 100)
    // 100.2 s is in the window and the recording, so it is written; 99 s never is.
    #expect(times(windows.add(fix(t: 101.2))) == [100.2, 101.2])
    #expect(times(windows.add(fix(t: 102.2))) == [102.2])
  }

  @Test func fixesAWindowTookBeforeTheRecordingOpenedAreKept() {
    var windows = GnssWindows()
    _ = feed(&windows, 0...10)
    #expect(windows.markStreetAnchor(at: 10.5).isEmpty)
    // The window takes its reference at 11 s and more fixes after it, all before the open.
    #expect(feed(&windows, 11...15).isEmpty)
    windows.recordingOpened(at: 13)
    // The next fix brings the window's fixes from 13 s on with it, in order, once each.
    #expect(times(windows.add(fix(t: 16))) == seconds(13...16))
    #expect(windows.markStreetAnchor(at: 16.5).isEmpty)
    #expect(times(windows.add(fix(t: 17))) == [17])
  }

  @Test func nothingBeforeTheRecordingOpensAtAll() {
    var windows = GnssWindows()
    _ = feed(&windows, 0...10)
    #expect(windows.markStreetAnchor(at: 10).isEmpty)
    #expect(feed(&windows, 11...50).isEmpty)
  }

  @Test func aFixTooFarFromTheFirstFixIsLeftOut() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    // Multipath off the buildings: at 45 s a fix 80 m north, at 46 s one 45 m north.
    let position: (Double) -> (east: Double, north: Double) = { t in
      t == 45 ? (0, 80) : t == 46 ? (0, 45) : (0, 0)
    }
    _ = feed(&windows, 0...50, position: position)
    let marked = windows.markStreetAnchor(at: 50)
    var expected = seconds(20...50)
    expected.removeAll { $0 == 45 }
    #expect(times(marked) == expected)
    // Later fixes are held to the same reference.
    #expect(windows.add(fix(t: 51, east: 80)).isEmpty)
    #expect(times(windows.add(fix(t: 52, east: 30))) == [52])
  }

  @Test func overlappingWindowsWriteEachFixOnce() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    var out = feed(&windows, 0...50)
    out += windows.markStreetAnchor(at: 50.5)
    out += feed(&windows, 51...70)
    out += windows.markStreetAnchor(at: 70.5)
    out += feed(&windows, 71...120)
    #expect(times(out) == seconds(21...100))
    #expect(zip(out.dropFirst(), out).allSatisfy { $0.t > $1.t })
  }

  @Test func aWindowWithNoFixAfterTheMarkEndsWithNothing() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    _ = feed(&windows, 0...50)
    #expect(windows.markStreetAnchor(at: 50.5).isEmpty)
    #expect(windows.openWindowCount == 1)
    // No fix until 81 s, after the window's end at 80.5 s.
    #expect(feed(&windows, 81...120).isEmpty)
    #expect(windows.openWindowCount == 0)
  }

  @Test func outOfOrderAndInvalidFixesAreDropped() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    _ = feed(&windows, 0...10)
    #expect(times(windows.markStreetAnchor(at: 10)) == seconds(0...10))
    let count = windows.bufferedCount
    let bad: [GnssFix] = [
      fix(t: 10),
      fix(t: 9.5),
      fix(t: 11, accuracy: -1),
      fix(t: 11, accuracy: .nan),
      fix(t: 11, accuracy: .infinity),
      GnssFix(t: 11, lat: .nan, lon: doorLon, horizontalAccuracyM: 5),
      GnssFix(t: 11, lat: doorLat, lon: .infinity, horizontalAccuracyM: 5),
      GnssFix(t: 11, lat: -180, lon: -180, horizontalAccuracyM: 5),
      fix(t: .nan),
      fix(t: .infinity),
    ]
    for f in bad { #expect(windows.add(f).isEmpty) }
    #expect(windows.bufferedCount == count)
    #expect(times(windows.add(fix(t: 11))) == [11])
  }

  @Test func theBufferKeepsOnlyWhatAWindowCouldNeed() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    _ = feed(&windows, 0...300)
    // 270 s to 300 s: a window marked now looks back 30 s.
    #expect(windows.bufferedCount == 31)
    #expect(windows.markStreetAnchor(at: 300.5).isEmpty)
    #expect(times(windows.add(fix(t: 301))) == seconds(271...301))
  }

  @Test func theBufferIsCapped() {
    var windows = GnssWindows()
    windows.recordingOpened(at: 0)
    // A clock that barely moves: 1000 fixes in 10 s, all inside one window's look-back.
    let fixes = (0..<1000).map { fix(t: Double($0) / 100) }
    for f in fixes { _ = windows.add(f) }
    #expect(windows.bufferedCount == GnssWindows.capacity)
    #expect(windows.markStreetAnchor(at: 10).isEmpty)
    let last = fix(t: 10)
    let out = windows.add(last)
    #expect(out == Array(fixes.suffix(GnssWindows.capacity)) + [last])
    #expect(windows.bufferedCount == GnssWindows.capacity)
  }

  @Test func theFixMirrorsTheGeneratedLine() {
    let f = fix(t: 12.5, east: 3, north: 4, accuracy: 6)
    let line = GnssLine(hAccuracyM: f.horizontalAccuracyM, lat: f.lat, lon: f.lon, t: f.t)
    #expect(line.t == f.t && line.lat == f.lat && line.lon == f.lon)
    #expect(line.hAccuracyM == f.horizontalAccuracyM)
  }
}
