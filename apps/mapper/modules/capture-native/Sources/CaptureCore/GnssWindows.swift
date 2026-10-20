import Foundation

/// One Core Location fix, as the module hands it over. It becomes a `location.jsonl` line (the
/// bundle's `gnss.jsonl` line) only if `GnssWindows` returns it.
public struct GnssFix: Equatable, Sendable {
  /// Seconds since the ARKit session started.
  public var t: Double
  /// WGS84 degrees.
  public var lat: Double
  public var lon: Double
  /// Core Location's horizontal accuracy in metres. Core Location reports a negative one when the
  /// fix is invalid.
  public var horizontalAccuracyM: Double

  public init(t: Double, lat: Double, lon: Double, horizontalAccuracyM: Double) {
    self.t = t
    self.lat = lat
    self.lon = lon
    self.horizontalAccuracyM = horizontalAccuracyM
  }
}

/// How much location a street-facing anchor may take (ADR 0010, "What a recording holds"). Only
/// the street around the door is needed to place the anchor, so the window is short and small.
public struct GnssWindowConfig: Equatable, Sendable {
  /// Fixes from this many seconds before the mark to this many after it.
  public var halfWidthS: Double
  /// Metres from the anchor's first fix.
  public var radiusM: Double

  public init(halfWidthS: Double = 30, radiusM: Double = 50) {
    precondition(halfWidthS > 0 && radiusM > 0)
    self.halfWidthS = halfWidthS
    self.radiusM = radiusM
  }

  /// ADR 0010's values: ±30 s and about 50 m.
  public static let standard = GnssWindowConfig()
}

/// Decides which GNSS fixes a recording writes (ADR 0010, "GNSS windows" in
/// docs/session-recording.md). A recording never holds continuous GNSS: only fixes within
/// ±`halfWidthS` of marking a street-facing anchor, inside the recording's window and within
/// `radiusM` of that anchor's first fix. Fixes wait in a small in-memory buffer, so a window can
/// begin before an anchor marked mid-session, but nothing from before the recording opened is
/// ever returned. The buffer is never written as it is.
///
/// Fixes come back in strictly increasing `t` across all calls, each at most once, so the module
/// appends them to `location.jsonl` as they come.
public struct GnssWindows: Sendable {
  /// The most fixes the buffer holds, whatever the clock does. At 1 Hz a window needs about 61.
  public static let capacity = 600

  public let config: GnssWindowConfig
  private var openedAt: Double?
  /// Accepted fixes, strictly increasing in `t`.
  private var buffer: [GnssFix] = []
  private var lastAddedT: Double?
  private var lastWrittenT: Double?
  private var windows: [Window] = []
  /// Fixes a window picked before the recording opened, at or after its opening time, waiting for
  /// the next `add` or `markStreetAnchor` to return them. In time order.
  private var pending: [GnssFix] = []

  private struct Window: Sendable {
    let mark: Double
    /// The anchor's first fix: the first one at or after the mark. Nil until it arrives.
    var reference: GnssFix?
  }

  public init(config: GnssWindowConfig = .standard) {
    self.config = config
  }

  /// The recording opened at `t`. Until this is called nothing is returned at all, and no fix
  /// from before `t` ever is. The recording opens once, so later calls are ignored.
  ///
  /// A street-facing start anchor opens the recording and its window at the same `t` (ADR 0010),
  /// so the two calls may come in either order. Fixes an open window already picked from `t` on
  /// are kept, and the next `add` or `markStreetAnchor` returns them first.
  public mutating func recordingOpened(at t: Double) {
    guard openedAt == nil, t.isFinite else { return }
    openedAt = t
    var picked = Set<Int>()
    for window in windows {
      guard let reference = window.reference else { continue }
      picked.formUnion(bufferedIndices(in: window, reference: reference))
    }
    pending = picked.sorted().map { buffer[$0] }.filter { $0.t >= t }
  }

  /// Buffers `fix` and returns the fixes now ready to write. Drops a fix whose accuracy is
  /// negative (Core Location's invalid fix) or not finite, whose coordinates are not finite or
  /// out of range, or whose `t` is not after the last fix added: the file is in time order.
  public mutating func add(_ fix: GnssFix) -> [GnssFix] {
    guard isValid(fix) else { return [] }
    lastAddedT = fix.t
    buffer.append(fix)
    let newIndex = buffer.count - 1
    let end = config.halfWidthS
    var picked = Set<Int>()
    var kept: [Window] = []
    for var window in windows {
      if fix.t > window.mark + end {
        // Past the window's end: it is over, with whatever it wrote (perhaps nothing).
        continue
      }
      if let reference = window.reference {
        if isNear(fix, reference) { picked.insert(newIndex) }
      } else if fix.t >= window.mark {
        window.reference = fix
        picked.formUnion(bufferedIndices(in: window, reference: fix))
      }
      kept.append(window)
    }
    windows = kept
    let out = emit(picked)
    prune()
    return out
  }

  /// A street-facing anchor was marked at `t`: opens the window [t - halfWidthS, t + halfWidthS].
  /// Returns the buffered fixes in it when the anchor's first fix is already buffered, else
  /// nothing until that fix arrives through `add`. Marks come at the current time; a mark older
  /// than the buffer can't find the fixes it would have needed.
  public mutating func markStreetAnchor(at t: Double) -> [GnssFix] {
    guard t.isFinite else { return [] }
    var window = Window(mark: t, reference: nil)
    if let first = buffer.first(where: { $0.t >= t }) {
      // A fix after the window's end means the window got no fix in time.
      guard first.t <= t + config.halfWidthS else { return [] }
      window.reference = first
    }
    windows.append(window)
    guard let reference = window.reference else { return [] }
    return emit(bufferedIndices(in: window, reference: reference))
  }

  /// How many fixes the buffer holds, for tests.
  var bufferedCount: Int { buffer.count }

  /// How many windows are still open, for tests.
  var openWindowCount: Int { windows.count }

  private func isValid(_ fix: GnssFix) -> Bool {
    guard fix.t.isFinite, fix.lat.isFinite, fix.lon.isFinite,
      fix.horizontalAccuracyM.isFinite, fix.horizontalAccuracyM >= 0,
      abs(fix.lat) <= 90, abs(fix.lon) <= 180
    else { return false }
    if let last = lastAddedT, fix.t <= last { return false }
    return true
  }

  private func isNear(_ fix: GnssFix, _ reference: GnssFix) -> Bool {
    haversineMetres(fix.lat, fix.lon, reference.lat, reference.lon) <= config.radiusM
  }

  /// Buffered fixes inside the window's time span and near its reference.
  private func bufferedIndices(in window: Window, reference: GnssFix) -> [Int] {
    let start = window.mark - config.halfWidthS
    let end = window.mark + config.halfWidthS
    return buffer.indices.filter { i in
      let fix = buffer[i]
      return fix.t >= start && fix.t <= end && isNear(fix, reference)
    }
  }

  /// Turns picked buffer indices, and any fixes still pending from before the recording opened,
  /// into fixes to write: in time order, once each, never before the recording opened. A fix
  /// older than one already written is dropped, since the file only grows forwards (two windows
  /// whose references are far apart can disagree about it).
  private mutating func emit<S: Sequence>(_ indices: S) -> [GnssFix] where S.Element == Int {
    guard let openedAt else { return [] }
    let candidates = (pending + Set(indices).map { buffer[$0] }).sorted { $0.t < $1.t }
    pending = []
    var out: [GnssFix] = []
    for fix in candidates {
      guard fix.t >= openedAt else { continue }
      if let last = lastWrittenT, fix.t <= last { continue }
      out.append(fix)
      lastWrittenT = fix.t
    }
    return out
  }

  /// Keeps only what a window could still need: a window marked from now on looks back at most
  /// `halfWidthS` from the newest fix, and a window still waiting for its first fix looks back
  /// `halfWidthS` from its mark. A window that has its reference only takes new fixes.
  private mutating func prune() {
    guard let newest = buffer.last?.t else { return }
    var cutoff = newest - config.halfWidthS
    for window in windows where window.reference == nil {
      cutoff = min(cutoff, window.mark - config.halfWidthS)
    }
    if let keepFrom = buffer.firstIndex(where: { $0.t >= cutoff }), keepFrom > 0 {
      buffer.removeFirst(keepFrom)
    }
    // A clock that barely moves would otherwise keep everything.
    if buffer.count > Self.capacity {
      buffer.removeFirst(buffer.count - Self.capacity)
    }
  }
}

/// Mean Earth radius in metres (IUGG), for `haversineMetres`.
let earthRadiusM = 6_371_008.8

/// Great-circle distance in metres between two WGS84 points, on a sphere. Over 50 m the error
/// against the ellipsoid is well under a metre; degree differences are never a distance.
func haversineMetres(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
  let toRadians = Double.pi / 180
  let phi1 = lat1 * toRadians
  let phi2 = lat2 * toRadians
  let dPhi = (lat2 - lat1) * toRadians
  let dLambda = (lon2 - lon1) * toRadians
  let a =
    sin(dPhi / 2) * sin(dPhi / 2) + cos(phi1) * cos(phi2) * sin(dLambda / 2) * sin(dLambda / 2)
  return 2 * earthRadiusM * asin(min(1, a.squareRoot()))
}
