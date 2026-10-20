#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

// ImuPairer, AltitudeRebaser and PreOpenBuffer, with synthetic 100 Hz streams.

private let still = SIMD3<Double>(0, -1, 0)

private func rate(_ marker: Double) -> SIMD3<Double> { SIMD3(marker, 0, 0) }

@Suite struct ImuPairerTests {
  @Test func pairsEachAccelerometerSampleWithTheNearestGyroSample() {
    var pairer = ImuPairer()
    var out: [ImuSample] = []
    // The gyro runs 2 ms behind the accelerometer.
    for i in 0..<5 {
      let t = Double(1000 + i) / 100
      out += pairer.accelerometer(t: t, g: still)
      out += pairer.gyro(t: t + 0.002, rate: rate(Double(i)))
    }
    #expect(out.map(\.t) == [10, 10.01, 10.02, 10.03, 10.04])
    #expect(out.map(\.gyro.x) == [0, 1, 2, 3, 4])
    #expect(out.allSatisfy { $0.accelG == still })
    #expect(pairer.droppedUnpaired == 0)
  }

  @Test func waitsForTheGyroSampleAfterItWhenThatOneIsNearer() {
    var pairer = ImuPairer()
    #expect(pairer.gyro(t: 9.996, rate: rate(1)).isEmpty)
    // 4 ms after the last gyro sample: a nearer one may still come.
    #expect(pairer.accelerometer(t: 10, g: still).isEmpty)
    let out = pairer.gyro(t: 10.001, rate: rate(2))
    #expect(out.map(\.gyro.x) == [2])
    #expect(out.map(\.t) == [10])
  }

  @Test func aTieGoesToTheEarlierGyroSample() {
    // Quarter seconds, so the two gaps are exactly equal.
    var pairer = ImuPairer(toleranceS: 0.5)
    _ = pairer.gyro(t: 9.75, rate: rate(1))
    _ = pairer.accelerometer(t: 10, g: still)
    #expect(pairer.gyro(t: 10.25, rate: rate(2)).map(\.gyro.x) == [1])
  }

  @Test func dropsAnAccelerometerSampleWithNoGyroSampleNearIt() {
    var pairer = ImuPairer()
    _ = pairer.gyro(t: 9.99, rate: rate(1))
    _ = pairer.accelerometer(t: 10, g: still)
    #expect(pairer.gyro(t: 10.01, rate: rate(2)).isEmpty)
    #expect(pairer.droppedUnpaired == 1)
  }

  @Test func dropsAndCountsTimesThatDontIncrease() {
    var pairer = ImuPairer()
    _ = pairer.accelerometer(t: 10, g: still)
    #expect(pairer.accelerometer(t: 10, g: still).isEmpty)
    #expect(pairer.accelerometer(t: 9.99, g: still).isEmpty)
    #expect(pairer.accelerometer(t: .nan, g: still).isEmpty)
    _ = pairer.gyro(t: 10.001, rate: rate(1))
    #expect(pairer.gyro(t: 10.001, rate: rate(2)).isEmpty)
    #expect(pairer.droppedNonIncreasing == 4)
  }

  @Test func aStalledGyroDoesntHoldTheAccelerometerForever() {
    var pairer = ImuPairer()
    _ = pairer.gyro(t: 10, rate: rate(1))
    var out: [ImuSample] = []
    for i in 0..<20 { out += pairer.accelerometer(t: 10.001 + Double(i) * 0.01, g: still) }
    // The first is paired with the gyro sample 1 ms before it once pushed out; the rest have none.
    #expect(out.map(\.gyro.x) == [1])
    #expect(pairer.droppedUnpaired == 20 - ImuPairer.capacity - 1)
    #expect(pairer.flush().isEmpty)
    #expect(pairer.droppedUnpaired == 20 - 1)
  }

  @Test func flushPairsWhatIsLeft() {
    var pairer = ImuPairer()
    _ = pairer.gyro(t: 9.999, rate: rate(1))
    _ = pairer.accelerometer(t: 10, g: still)
    #expect(pairer.flush().map(\.t) == [10])
  }
}

@Suite struct AltitudeRebaserTests {
  @Test func measuresFromTheFirstSampleWritten() throws {
    var rebaser = AltitudeRebaser()
    let encoder = LineEncoder()
    func written(_ t: Double, _ raw: Double) throws -> String {
      let pending = rebaser.line(AltitudeSample(t: t, relativeAltitudeM: raw, pressureKpa: 101.4))
      let line = try #require(pending)
      return String(decoding: try line.encode(encoder), as: UTF8.self)
    }
    // The altimeter started before the window: its zero is not the recording's.
    #expect(try written(5, -3.2).contains(#""relative_m":0,"#))
    #expect(try written(6, -3.1).contains(#""relative_m":0.1,"#))
    #expect(try written(7, -8.0004).contains(#""relative_m":-4.8,"#))
  }

  @Test func dropsTimesThatDontIncrease() {
    var rebaser = AltitudeRebaser()
    #expect(rebaser.line(AltitudeSample(t: 5, relativeAltitudeM: 0, pressureKpa: 101)) != nil)
    #expect(rebaser.line(AltitudeSample(t: 5, relativeAltitudeM: 0, pressureKpa: 101)) == nil)
    #expect(rebaser.line(AltitudeSample(t: .nan, relativeAltitudeM: 0, pressureKpa: 101)) == nil)
    #expect(rebaser.droppedNonIncreasing == 2)
  }
}

@Suite struct PreOpenBufferTests {
  private func imu(_ t: Double) -> ImuSample { ImuSample(t: t, accelG: still, gyro: .zero) }

  @Test func releasesOnlySamplesAtOrAfterTheStart() {
    var buffer = PreOpenBuffer()
    for i in 0..<300 { buffer.add(imu(Double(i) / 100)) }
    buffer.add(AltitudeSample(t: 2.5, relativeAltitudeM: 0, pressureKpa: 101))
    buffer.add(AltitudeSample(t: 2.95, relativeAltitudeM: 0, pressureKpa: 101))
    let released = buffer.release(startT: 2.9)
    #expect(released.imu.map(\.t) == [2.9, 2.91, 2.92, 2.93, 2.94, 2.95, 2.96, 2.97, 2.98, 2.99])
    #expect(released.altitude.map(\.t) == [2.95])
    #expect(released.motion.isEmpty)
    #expect(buffer.count == 0)
  }

  @Test func holdsOnlyTheLastTwoSeconds() {
    var buffer = PreOpenBuffer()
    // Quarter seconds, which are exact: 24.75 back to 22.75 is 9 samples.
    for i in 0..<100 { buffer.add(imu(Double(i) * 0.25)) }
    let released = buffer.release(startT: 0)
    #expect(released.imu.count == 9)
    #expect(released.imu.first?.t == 22.75)
  }

  @Test func holdsAtMostItsCapacity() {
    var buffer = PreOpenBuffer(spanS: 2, capacity: 50)
    // A burst with equal times can't grow the buffer past its capacity.
    for _ in 0..<500 { buffer.add(imu(1)) }
    #expect(buffer.count == 50)
  }

  @Test func clearDropsEverything() {
    var buffer = PreOpenBuffer()
    buffer.add(imu(1))
    buffer.clear()
    #expect(buffer.release(startT: 0).imu.isEmpty)
  }
}
#endif
