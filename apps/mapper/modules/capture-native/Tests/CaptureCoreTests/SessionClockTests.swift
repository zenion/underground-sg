#if USG_RECORDER
import Foundation
import Testing

@testable import CaptureCore

/// A session that started 81,234.5 s after boot, at 08:15:02.104 in Singapore on 20 Oct 2026.
private let clock = SessionClock(
  uptime: 81_234.5, media: 81_234.25, wall: Date(timeIntervalSince1970: 1_792_455_302.104))

@Suite struct SessionClockTests {
  @Test func sessionTimeIsUptimeSinceTheStartToTheMicrosecond() {
    #expect(clock.t(uptime: 81_237.7) == 3.2)
    #expect(clock.t(uptime: 81_234.5) == 0)
    #expect(clock.t(uptime: 81_234.500_000_4) == 0)
    #expect(clock.t(uptime: 81_234.500_001_6) == 0.000_002)
  }

  @Test func timesBeforeTheStartAreNotWritten() {
    #expect(clock.t(uptime: 81_234.4) == nil)
    #expect(clock.t(uptime: 0) == nil)
    #expect(clock.t(uptime: .nan) == nil)
    #expect(clock.t(uptime: .infinity) == nil)
  }

  @Test func aTimeJustBeforeTheStartRoundsToAPositiveZero() throws {
    let t = try #require(clock.t(uptime: 81_234.499_999_6))
    #expect(t == 0)
    #expect(t.sign == .plus)
  }

  @Test func aFixIsDatedByItsAge() {
    // Received at 66 s; Core Location says the fix is 2.25 s old.
    #expect(clock.t(fixAgeS: 2.25, nowUptime: 81_300.5) == 63.75)
    // A fix stamped in the future (wall clock skew) is taken as now.
    #expect(clock.t(fixAgeS: -0.5, nowUptime: 81_300.5) == 66)
    // A fix from before the session started is never written.
    #expect(clock.t(fixAgeS: 70, nowUptime: 81_300.5) == nil)
    #expect(clock.t(fixAgeS: .nan, nowUptime: 81_300.5) == nil)
  }

  @Test func wallClockTextIsSingaporeTimeWithMilliseconds() {
    #expect(clock.sessionStartedAt == "2026-10-20T08:15:02.104+08:00")
    // Across midnight UTC into a new year in Singapore.
    #expect(
      singaporeTime(Date(timeIntervalSince1970: 1_798_734_600)) == "2027-01-01T00:30:00.000+08:00")
    // A leap day, and a millisecond that rounds up into the next second.
    #expect(
      singaporeTime(Date(timeIntervalSince1970: 1_835_380_800.9996))
        == "2028-02-29T04:00:01.000+08:00")
    #expect(singaporeTime(Date(timeIntervalSince1970: 0)) == "1970-01-01T08:00:00.000+08:00")
  }

  @Test func theClocksAreWrittenAsRead() throws {
    let line = String(decoding: try LineEncoder().line(clock.clocks), as: UTF8.self)
    #expect(
      line
        == #"{"media_time_s":81234.25,"system_uptime_s":81234.5,"#
        + #""wall_clock":"2026-10-20T08:15:02.104+08:00"}"# + "\n")
  }
}
#endif
