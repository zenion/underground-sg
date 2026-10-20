#if USG_RECORDER
import Foundation

/// The session's time base (docs/session-recording.md, "Values, frames and time"; design D15 and
/// D26): `t` is seconds since the ARKit session started, on the uptime clock that ARFrame and
/// Core Motion timestamps use. The module reads the three clocks together just before
/// `session.run`, and every timestamp becomes a `t` here.
///
/// Holds times only. The module writes them to recording.json and never logs them.
public struct SessionClock: Sendable {
  /// `ProcessInfo.systemUptime` at t = 0, in seconds.
  public let uptime: Double
  /// `CACurrentMediaTime()` read with it.
  public let media: Double
  /// `Date()` read with it.
  public let wall: Date

  public init(uptime: Double, media: Double, wall: Date) {
    self.uptime = uptime
    self.media = media
    self.wall = wall
  }

  /// The session time of an uptime-clock timestamp, rounded to the microsecond so lines stay
  /// short. Nil for a time before the session started, or one that isn't finite: such samples
  /// are not written.
  public func t(uptime timestamp: Double) -> Double? {
    let t = ((timestamp - uptime) * 1e6).rounded() / 1e6
    guard t.isFinite, t >= 0 else { return nil }
    // -0.0 rounds from a time a fraction of a microsecond early; it is written as 0.
    return t == 0 ? 0 : t
  }

  /// The session time of a Core Location fix (D15): now on the uptime clock, less the fix's age.
  /// Only the age comes from the wall clock (`Date().timeIntervalSince(fix.timestamp)`), so a
  /// wall-clock step during the session moves no fix by more than the step within the age. A
  /// negative age (a fix stamped a moment in the future) counts as 0.
  public func t(fixAgeS: Double, nowUptime: Double) -> Double? {
    guard fixAgeS.isFinite else { return nil }
    return t(uptime: nowUptime - max(0, fixAgeS))
  }

  /// recording.json's `session_started_at`: the wall clock at t = 0.
  public var sessionStartedAt: String { singaporeTime(wall) }

  /// recording.json's `clocks`, read together at session start.
  var clocks: RecordingClocks {
    RecordingClocks(mediaTimeS: media, systemUptimeS: uptime, wallClock: singaporeTime(wall))
  }
}

/// RFC 3339 in Singapore time with milliseconds, as the format wants (`+08:00`):
/// 2026-10-20T08:15:02.104+08:00. Integer arithmetic on the days since 1970 (the proleptic
/// Gregorian calendar), so the text is the same on every platform and needs no formatter or
/// locale. Rounded to the millisecond first, so a carry into the next second, day or year is
/// already in the integer.
func singaporeTime(_ date: Date) -> String {
  let ms = Int64((date.timeIntervalSince1970 * 1000).rounded()) + 8 * 3_600_000
  let (days, msOfDay) = floorDivide(ms, 86_400_000)
  let (year, month, day) = civilDate(daysSince1970: days)
  let hour = msOfDay / 3_600_000
  let minute = msOfDay / 60_000 % 60
  let second = msOfDay / 1000 % 60
  let millisecond = msOfDay % 1000
  return "\(pad(year, 4))-\(pad(month, 2))-\(pad(day, 2))T\(pad(hour, 2)):\(pad(minute, 2)):"
    + "\(pad(second, 2)).\(pad(millisecond, 3))+08:00"
}

private func floorDivide(_ a: Int64, _ b: Int64) -> (quotient: Int64, remainder: Int64) {
  let remainder = (a % b + b) % b
  return ((a - remainder) / b, remainder)
}

/// Year, month and day of a day count from 1970-01-01 (Howard Hinnant's civil_from_days).
private func civilDate(daysSince1970 days: Int64) -> (Int64, Int64, Int64) {
  let z = days + 719_468
  let era = (z >= 0 ? z : z - 146_096) / 146_097
  let dayOfEra = z - era * 146_097
  let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
  let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
  let monthIndex = (5 * dayOfYear + 2) / 153
  let day = dayOfYear - (153 * monthIndex + 2) / 5 + 1
  let month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9
  let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
  return (year, month, day)
}

private func pad(_ value: Int64, _ width: Int) -> String {
  let text = String(value)
  return String(repeating: "0", count: max(0, width - text.count)) + text
}
#endif
