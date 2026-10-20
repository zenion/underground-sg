#if USG_RECORDER
import Foundation

// The recorder's state machine (design section 6), confined to the capture queue. It takes the
// values the module copies out of ARKit, Core Motion and Core Location, decides what belongs in
// the recording, and returns SinkCommands for the I/O queue. It never touches a file, so every
// row of the table below is tested with scripted sessions and a MemorySink.
//
// | From          | Input                                    | To and commands                            |
// | ------------- | ---------------------------------------- | ------------------------------------------ |
// | armed         | samples, fixes, events, anchors          | armed; held in memory only, nothing out    |
// | armed         | stop, discard, failure, background       | discarded; nothing out                     |
// | armed         | first start mark                         | open: createRecording, the opening lines,  |
// |               |                                          | baseline anchors and mesh                  |
// | open          | end mark at te                           | open: journal end, registerCut(te+margin)  |
// | open          | end mark with End the session here       | closing: also journal closing(deadline)    |
// | closing       | frame with t + 1.5/fps >= deadline       | finalizing (end_anchor at t, final sample) |
// |               |                                          | then stopSession (D16)                     |
// | closing       | frame past the deadline (a gap)          | finalizing (end_anchor at the deadline,    |
// |               |                                          | final sample from this frame) and stop     |
// | closing       | stop                                     | finalizing (end_anchor at t, final sample) |
// | open          | idle                                     | finalizing (idle, final sample)            |
// | open, closing | background, heat, disk, limit            | finalizing (that reason, no final sample)  |
// | open          | stop with an end anchor                  | finalizing (stop, cut back, no final)      |
// | open          | stop without an end anchor, or discard   | discarded: journal discard, delete         |
// | finalizing    | the sink finished                        | closed                                     |
//
// Every line passes `admit`, which asks RecorderWindow.accepts first, so nothing outside the
// window is ever handed to a sink (design 12).

/// The recorder's settings for one session.
public struct RecorderConfig: Equatable, Sendable {
  public var window: RecorderWindowConfig
  /// Seconds between mesh snapshots: 5, or 2 in `dense`.
  public var meshIntervalS: Double
  public var degradation: DegradationConfig
  public var gnss: GnssWindowConfig
  /// The last frame index the format allows; a later frame closes the recording as `limit`.
  public var maxFrameIndex: Int
  /// Seconds of sensor samples held while armed.
  public var preOpenSpanS: Double

  public init(
    window: RecorderWindowConfig = .provisional, meshIntervalS: Double = 5,
    degradation: DegradationConfig = .provisional, gnss: GnssWindowConfig = .standard,
    maxFrameIndex: Int = 999_999, preOpenSpanS: Double = 2
  ) {
    precondition(meshIntervalS > 0 && maxFrameIndex >= 0 && preOpenSpanS > 0)
    self.window = window
    self.meshIntervalS = meshIntervalS
    self.degradation = degradation
    self.gnss = gnss
    self.maxFrameIndex = maxFrameIndex
    self.preOpenSpanS = preOpenSpanS
  }

  public static let lean = RecorderConfig()
}

public enum RecorderPhase: Equatable, Sendable {
  /// Started with a grant; nothing on disk until the first start mark.
  case armed
  case open
  /// End the session here was marked; the window closes at `deadline`.
  case closing(deadline: Double)
  /// The window closed; the sink is finishing the files.
  case finalizing(WindowClose)
  case closed(WindowClose)
  /// Nothing of the session is kept.
  case discarded
}

/// A mark the module handled on the current frame, after raycasting.
public struct MarkInput: Equatable, Sendable {
  public var role: AnchorMarkRole
  public var streetFacing: Bool
  public var endSessionHere: Bool

  public init(role: AnchorMarkRole, streetFacing: Bool = false, endSessionHere: Bool = false) {
    self.role = role
    self.streetFacing = streetFacing
    self.endSessionHere = endSessionHere
  }
}

/// A session call JavaScript made and what it got back: one actions.jsonl line. `args` and
/// `result` are JSON text; `error` is the error's code.
public struct ActionInput: Equatable, Sendable {
  public var call: SessionCall
  public var t: Double
  public var args: String
  public var result: String?
  public var error: String?

  public init(call: SessionCall, t: Double, args: String, result: String?, error: String?) {
    self.call = call
    self.t = t
    self.args = args
    self.result = result
    self.error = error
  }
}

/// What the recorder refused or dropped, for the debug figures. Counts only.
public struct RecorderCounts: Equatable, Sendable {
  /// Lines whose `t` the window doesn't accept.
  public var outsideWindow = 0
  /// Lines whose `t` would go back in their file.
  public var nonIncreasing = 0
  public var boundaryRefused = 0
  /// Events only the recorder itself writes (opened, closed, configuration, degradation).
  public var ignoredEvents = 0
}

public final class RecorderCore {
  public let id: UUID
  public let grant: RecordingGrant
  public let config: RecorderConfig
  public let manifestBase: ManifestBase
  public private(set) var phase: RecorderPhase = .armed
  public private(set) var counts = RecorderCounts()
  /// False while the mesh queue is still busy with the last job: the next snapshot waits, with
  /// its anchors still pending.
  public var meshQueueIdle = true

  private var window: RecorderWindow
  private var preOpen: PreOpenBuffer
  private var gnss: GnssWindows
  private var ladder: DegradationLadder
  private var schedule: MeshHistorySchedule
  private var sampler = AnchorSampler()
  private var rebaser = AltitudeRebaser()
  /// Mesh anchors updated since their last block, for the final snapshot's reuse (design D6).
  private var pendingMeshUpdated: Set<UUID> = []
  private var lastFrame: FrameSample?
  private var lastFrameLineT: Double?
  private var lastLineT: [RecordingFilePath: Double] = [:]
  private var lastBoundarySeq: Int?
  private var snapshotTs: [Double] = []
  private var thermal: DeviceThermal = .nominal
  private var freeDiskBytes: Int64 = .max
  private var awaitingBoundary = false

  /// The files whose `t` strictly increases (docs/session-recording.md); the others may repeat.
  private static let sampleStreams: Set<RecordingFilePath> = [
    .frames, .imu, .motion, .altitude, .telemetry, .location,
  ]

  /// A synthetic grant only makes synthetic recordings and a device grant only device ones, so
  /// generated data is never labelled as recorded or the other way round.
  public init(
    grant: RecordingGrant, id: UUID, config: RecorderConfig = .lean, manifestBase: ManifestBase
  ) {
    precondition(grant.origin == manifestBase.origin, "the grant and the origin must agree")
    self.grant = grant
    self.id = id
    self.config = config
    self.manifestBase = manifestBase
    window = RecorderWindow(config: config.window)
    preOpen = PreOpenBuffer(spanS: config.preOpenSpanS)
    gnss = GnssWindows(config: config.gnss)
    ladder = DegradationLadder(profile: grant.profile, config: config.degradation)
    schedule = MeshHistorySchedule(intervalS: config.meshIntervalS)
  }

  /// The window as it stands, for the status event.
  public var windowState: RecorderWindowState { window.state }

  // MARK: - Frames, marks and stop

  /// A delegate frame. While armed it is only remembered (a mark may open the window on it).
  /// While open it is written, it may close the window (End the session here, idle, the
  /// longest session), and it may take a mesh snapshot. `readAnchors` is called at most once,
  /// inside this call, for the anchors and the geometry asked for.
  public func frame(
    _ s: FrameSample, position: SIMD3<Double>, readAnchors: (GeometryRequest) -> AnchorReading
  ) -> [SinkCommand] {
    switch phase {
    case .armed:
      lastFrame = s
      return []
    case .open, .closing:
      break
    case .finalizing, .closed, .discarded:
      return []
    }
    if let last = lastFrame, !(s.t > last.t) {
      counts.nonIncreasing += 1
      return []
    }
    guard s.frame <= config.maxFrameIndex else {
      // The format numbers frames to 999,999; this frame isn't written.
      return closeWithoutSample(.limit, at: lastFrame?.t ?? s.t)
    }
    lastFrame = s
    window.observe(t: s.t, position: (position.x, position.y, position.z))
    // D16: the first frame within 1.5 frame intervals of the deadline ends the window here, so
    // the final sample and the session's stop come from a real frame at end_t.
    if case .closing(_, let deadline) = window.state,
      s.t + 1.5 / Double(max(s.fps, 1)) >= deadline
    {
      window.stop(at: s.t)
    }
    var lines: [PendingLine] = []
    appendFrameLine(s, to: &lines)
    var commands: [SinkCommand] = lines.isEmpty ? [] : [.lines(lines)]
    if case .closed = window.state {
      return commands + finish(readAnchors: readAnchors, sampling: true, fromFrame: true)
    }
    syncLivePhase()
    commands += snapshotIfDue(at: s.t, readAnchors: readAnchors)
    return commands
  }

  /// A mark handled on the frame last passed to `frame`; its `t` is that frame's. The first start
  /// mark opens the recording. An end mark while open is journaled and arms the cut, and with
  /// End the session here starts the closing. Other marks change nothing.
  public func mark(_ m: MarkInput, readAnchors: (GeometryRequest) -> AnchorReading)
    -> [SinkCommand]
  {
    guard let frame = lastFrame else { return [] }
    let t = frame.t
    switch phase {
    case .armed:
      guard m.role == .start else { return [] }
      window.markAnchor(t: t, role: .start)
      guard case .open = window.state else { return [] }
      return open(at: t, streetFacing: m.streetFacing, readAnchors: readAnchors)
    case .open:
      window.markAnchor(t: t, role: m.role, endSessionHere: m.endSessionHere)
      if case .closed = window.state {
        return finish(readAnchors: noAnchors, sampling: false, fromFrame: false)
      }
      var commands: [SinkCommand] = []
      if m.streetFacing {
        var lines: [PendingLine] = []
        for fix in gnss.markStreetAnchor(at: t) { admit(.location(fix), to: &lines) }
        if !lines.isEmpty { commands.append(.lines(lines)) }
      }
      if m.role == .end, window.lastEndAnchorT == t {
        commands.append(.journal(.end(t: t)))
        commands.append(.registerCut(cutT: t + config.window.endMarginS))
      }
      if case .closing(_, let deadline) = window.state {
        commands.append(.journal(.closing(deadline: deadline)))
      }
      syncLivePhase()
      return commands
    case .closing, .finalizing, .closed, .discarded:
      return []
    }
  }

  /// The session's `stop`, handled on the next frame at `frameT` (after `frame`). Armed: nothing
  /// was written, so nothing is kept. Open: cut back to the last end anchor plus the margin, with
  /// no final sample, or discarded without an end anchor. Closing: closes as `end_anchor` at
  /// `frameT` with a final sample from this frame.
  public func stopRequested(frameT: Double, readAnchors: (GeometryRequest) -> AnchorReading)
    -> [SinkCommand]
  {
    switch phase {
    case .armed:
      window.stop(at: frameT)
      return discardArmed()
    case .open:
      window.stop(at: frameT)
      if case .discarded = window.state { return discardOpen() }
      return finish(readAnchors: noAnchors, sampling: false, fromFrame: false)
    case .closing:
      window.stop(at: frameT)
      return finish(readAnchors: readAnchors, sampling: true, fromFrame: false)
    case .finalizing, .closed, .discarded:
      return []
    }
  }

  /// The session's `discard`: nothing of it is kept. A closed recording is deleted through the
  /// store instead, so this does nothing once the window closed.
  public func discard() -> [SinkCommand] {
    switch phase {
    case .armed: return discardArmed()
    case .open, .closing: return discardOpen()
    case .finalizing, .closed, .discarded: return []
    }
  }

  /// Closes for `background`, `heat`, `disk` or `limit` (other reasons are ignored), at the last
  /// frame's `t` or `t`, whichever is earlier, with no final sample (design D1). While armed the
  /// session is just discarded.
  public func close(at t: Double, reason: WindowEndReason) -> [SinkCommand] {
    switch reason {
    case .background, .heat, .disk, .limit: break
    case .endAnchor, .stop, .idle, .interrupted: return []
    }
    return closeWithoutSample(reason, at: min(t, lastFrame?.t ?? t))
  }

  /// The sink hit a size limit (`limit`), or ENOSPC, EIO or a stalled backlog (`disk`).
  public func sinkLimitReached(_ reason: WindowEndReason = .limit) -> [SinkCommand] {
    guard reason == .limit || reason == .disk else { return [] }
    return close(at: lastFrame?.t ?? 0, reason: reason)
  }

  /// The sink finished the files and recording.json.
  public func finalizeCompleted() {
    if case .finalizing(let close) = phase { phase = .closed(close) }
  }

  // MARK: - Streams

  public func meshUpdated(_ anchor: UUID) {
    guard isLive else { return }
    schedule.anchorUpdated(anchor)
    pendingMeshUpdated.insert(anchor)
  }

  public func meshRemoved(_ anchor: UUID) {
    guard isLive else { return }
    schedule.anchorRemoved(anchor)
    pendingMeshUpdated.remove(anchor)
  }

  public func imu(_ batch: [ImuSample]) -> [SinkCommand] {
    if case .armed = phase {
      for sample in batch { preOpen.add(sample) }
      return []
    }
    guard isLive else { return [] }
    var lines: [PendingLine] = []
    for sample in batch { admit(.imu(sample), to: &lines) }
    return lines.isEmpty ? [] : [.lines(lines)]
  }

  /// Device motion. Without a reference frame (device motion unavailable) nothing is written,
  /// so motion.jsonl stays empty, as recording.json's `motion: null` says.
  public func motion(_ batch: [MotionSample]) -> [SinkCommand] {
    guard manifestBase.motionFrame != nil else { return [] }
    if case .armed = phase {
      for sample in batch { preOpen.add(sample) }
      return []
    }
    guard isLive else { return [] }
    var lines: [PendingLine] = []
    for sample in batch { appendMotion(sample, to: &lines) }
    return lines.isEmpty ? [] : [.lines(lines)]
  }

  public func altitude(_ sample: AltitudeSample) -> [SinkCommand] {
    if case .armed = phase {
      preOpen.add(sample)
      return []
    }
    guard isLive else { return [] }
    var lines: [PendingLine] = []
    appendAltitude(sample, to: &lines)
    return lines.isEmpty ? [] : [.lines(lines)]
  }

  /// A Core Location fix. While armed it waits in GnssWindows' memory, which never returns a fix
  /// from before the recording opened.
  public func gnss(_ fix: GnssFix) -> [SinkCommand] {
    switch phase {
    case .armed:
      _ = gnss.add(fix)
      return []
    case .open, .closing:
      var lines: [PendingLine] = []
      for written in gnss.add(fix) { admit(.location(written), to: &lines) }
      return lines.isEmpty ? [] : [.lines(lines)]
    case .finalizing, .closed, .discarded:
      return []
    }
  }

  /// A session call. SessionCall has no case for the recorder's plumbing, so it can't be logged.
  /// `t` is clamped so actions.jsonl never goes back.
  public func action(_ a: ActionInput) -> [SinkCommand] {
    guard isLive else { return [] }
    let t = max(a.t, lastLineT[.actions] ?? a.t)
    var lines: [PendingLine] = []
    admit(
      .action(a.call, t: t, args: a.args, result: a.result, error: a.error), to: &lines)
    return lines.isEmpty ? [] : [.lines(lines)]
  }

  /// Boundary lines from TypeScript, checked one by one (design D21). Accepted while the window
  /// is open, and after a foreground close until the final flush. `final` marks that flush.
  public func boundary(_ texts: [String], final: Bool) -> [SinkCommand] {
    let accepting: Bool
    switch phase {
    case .open, .closing: accepting = true
    case .finalizing: accepting = awaitingBoundary
    case .armed, .closed, .discarded: accepting = false
    }
    guard accepting else { return [] }
    var lines: [PendingLine] = []
    for text in texts {
      switch BoundaryLineCheck.check(
        text, window: window, lastSeq: lastBoundarySeq, lastT: lastLineT[.boundary])
      {
      case .success(let checked):
        lastBoundarySeq = checked.seq
        admit(.boundary(checked), to: &lines)
      case .failure:
        counts.boundaryRefused += 1
      }
    }
    var commands: [SinkCommand] = lines.isEmpty ? [] : [.lines(lines)]
    if final, case .finalizing = phase {
      awaitingBoundary = false
      commands.append(.boundaryFlushed)
    }
    return commands
  }

  /// An event at `t`, clamped so events.jsonl never goes back. The recorder writes its own
  /// opened, closed, configuration and degradation events; those are refused here. A thermal
  /// change runs the degradation ladder.
  public func event(_ e: RecordingEvent, t: Double) -> [SinkCommand] {
    switch e {
    case .recordingOpened, .recordingClosed, .configuration, .degradation:
      counts.ignoredEvents += 1
      return []
    default:
      break
    }
    if case .thermal(let state) = e { thermal = state }
    guard isLive else { return [] }
    var lines: [PendingLine] = []
    let stamped = appendEvent(e, t: t, to: &lines)
    var commands: [SinkCommand] = lines.isEmpty ? [] : [.lines(lines)]
    if case .thermal = e { commands += degrade(at: stamped) }
    return commands
  }

  /// One telemetry second; runs the degradation ladder.
  public func telemetry(_ s: TelemetrySample) -> [SinkCommand] {
    thermal = s.thermal
    freeDiskBytes = s.freeDiskBytes
    guard isLive else { return [] }
    var lines: [PendingLine] = []
    admit(.telemetry(s), to: &lines)
    let commands: [SinkCommand] = lines.isEmpty ? [] : [.lines(lines)]
    return commands + degrade(at: s.t)
  }

  // MARK: - Opening and closing

  private var isLive: Bool {
    switch phase {
    case .open, .closing: true
    case .armed, .finalizing, .closed, .discarded: false
    }
  }

  /// Design section 6, armed → open, in the table's order.
  private func open(
    at t: Double, streetFacing: Bool, readAnchors: (GeometryRequest) -> AnchorReading
  ) -> [SinkCommand] {
    let manifest: Data
    do {
      manifest = try RecordingDocuments.opening(
        id: id, base: manifestBase, profile: grant.profile, venues: grant.venues, startT: t)
    } catch {
      // A clock that isn't finite: nothing can be written, so nothing is.
      window.close(at: t, reason: .interrupted)
      return discardArmed()
    }
    phase = .open
    let journalOpen = JournalRecord.open(
      JournalOpen(
        id: id, startT: t, profile: grant.profile, marginS: config.window.endMarginS,
        idleS: config.window.idleTimeoutS, maxS: config.window.maxSessionS))
    var commands: [SinkCommand] = [
      .createRecording(id: id, journalOpen: journalOpen, manifest: manifest)
    ]
    var lines: [PendingLine] = []
    admit(.event(.recordingOpened, t: t), to: &lines)
    for code in configurationCodes() { admit(.event(.configuration(code), t: t), to: &lines) }
    let released = preOpen.release(startT: t)
    for sample in released.imu { admit(.imu(sample), to: &lines) }
    if manifestBase.motionFrame != nil {
      for sample in released.motion { appendMotion(sample, to: &lines) }
    }
    for sample in released.altitude { appendAltitude(sample, to: &lines) }
    if let frame = lastFrame { appendFrameLine(frame, to: &lines) }

    // The baseline: every anchor the session already has, and every mesh anchor's geometry.
    let reading = readAnchors(.everyMeshAnchor)
    for change in sampler.sample(t: t, anchors: reading.anchors) {
      admit(.anchor(change, final: false, captureID: nil), to: &lines)
    }
    for anchor in reading.anchors where anchor.kind == .mesh {
      schedule.anchorUpdated(anchor.id)
    }
    let plan = schedule.take(at: t)
    pendingMeshUpdated = []

    gnss.recordingOpened(at: t)
    if streetFacing {
      for fix in gnss.markStreetAnchor(at: t) { admit(.location(fix), to: &lines) }
    }
    commands.append(.lines(lines))
    commands.append(.mesh(meshJob(t: t, plan: plan, reading: reading)))
    snapshotTs.append(t)
    return commands
  }

  /// The configuration events written at open (design section 5).
  private func configurationCodes() -> [ConfigCode] {
    let arkit = manifestBase.arkit
    var codes: [ConfigCode?] = [ConfigCode(grant.profile.rawValue)]
    if arkit.reconstruction != .none { codes.append(.named(arkit.reconstruction.rawValue)) }
    codes += arkit.semantics.map { ConfigCode.named($0.rawValue) }
    codes.append(.named(arkit.alignment.rawValue))
    codes.append(.video(width: arkit.videoWidth, height: arkit.videoHeight, fps: arkit.fps))
    if let frame = manifestBase.motionFrame { codes.append(.motion(frame)) }
    codes.append(.gnssTFixAge)
    codes.append(.margin(seconds: config.window.endMarginS))
    codes.append(.idle(seconds: config.window.idleTimeoutS))
    return codes.compactMap { $0 }
  }

  /// A snapshot every `meshIntervalS` while open: the anchors.jsonl sample and, unless the
  /// ladder stopped it, the mesh job for the anchors updated and removed since the last one.
  private func snapshotIfDue(
    at t: Double, readAnchors: (GeometryRequest) -> AnchorReading
  ) -> [SinkCommand] {
    guard isLive, meshQueueIdle, schedule.isDue(at: t), window.accepts(t: t) else { return [] }
    let plan = schedule.take(at: t)
    let keepsMesh = ladder.keepsMeshHistory
    let reading = readAnchors(keepsMesh && !plan.updated.isEmpty ? .anchors(plan.updated) : .none)
    var lines: [PendingLine] = []
    for change in sampler.sample(t: t, anchors: reading.anchors) {
      admit(.anchor(change, final: false, captureID: nil), to: &lines)
    }
    pendingMeshUpdated = []
    var commands: [SinkCommand] = lines.isEmpty ? [] : [.lines(lines)]
    if keepsMesh {
      snapshotTs.append(t)
      if !plan.updated.isEmpty || !plan.removed.isEmpty {
        commands.append(.mesh(meshJob(t: t, plan: plan, reading: reading)))
      }
    }
    return commands
  }

  private func meshJob(t: Double, plan: MeshSnapshotPlan, reading: AnchorReading) -> MeshJob {
    let transforms = Dictionary(
      reading.anchors.filter { $0.kind == .mesh }.map { ($0.id, $0.transform) },
      uniquingKeysWith: { first, _ in first })
    let copies = plan.updated.compactMap { id -> MeshCopy? in
      guard let transform = transforms[id], let geometry = reading.geometry[id] else { return nil }
      return MeshCopy(id: id, transform: transform, geometry: geometry)
    }
    return MeshJob(t: t, final: false, copies: copies, reuse: [], removed: plan.removed)
  }

  /// Stands in for a frame's anchors when there is no frame to read: a close without a sample.
  private let noAnchors: (GeometryRequest) -> AnchorReading = { _ in AnchorReading(anchors: []) }

  /// The window closed: the final sample when the reason takes one and a frame is at hand
  /// (`sampling`), the `recording_closed` event, and the finalize order.
  private func finish(
    readAnchors: (GeometryRequest) -> AnchorReading, sampling: Bool, fromFrame: Bool
  ) -> [SinkCommand] {
    guard case .closed(let startT, let endT, let reason, let trimmed) = window.state else {
      return []
    }
    var commands: [SinkCommand] = []
    var closing: [PendingLine] = []
    var finalSample = false
    if sampling && (reason == .endAnchor || reason == .idle) {
      finalSample = true
      let keepsMesh = ladder.keepsMeshHistory
      let pending = pendingMeshUpdated.sorted(by: recordingOrder)
      let reading = readAnchors(keepsMesh ? .anchors(pending) : .none)
      for change in sampler.sampleFinal(t: endT, anchors: reading.anchors) {
        closing.append(.anchor(change, final: true, captureID: nil))
      }
      if keepsMesh {
        commands.append(.mesh(finalMeshJob(at: endT, reading: reading)))
        snapshotTs.append(endT)
      }
    }
    closing.append(.event(.recordingClosed(reason), t: endT))
    let kept = closing.filter { window.accepts(t: $0.t) }
    counts.outsideWindow += closing.count - kept.count
    let close = WindowClose(
      startT: startT, endT: endT, reason: reason, trimmed: trimmed, finalSample: finalSample)
    awaitingBoundary = reason != .background
    commands.append(
      .finalize(
        CloseOrder(
          window: close, closingLines: kept,
          meshSnapshotTs: snapshotTs.filter { $0 >= startT && $0 <= endT },
          awaitBoundary: awaitingBoundary, useCut: reason == .stop && trimmed)))
    if fromFrame && reason == .endAnchor && finalSample { commands.append(.stopSession) }
    phase = .finalizing(close)
    preOpen.clear()
    return commands
  }

  /// The final snapshot (design D6): every mesh anchor at `endT`. Anchors updated since their
  /// last block are copied; the rest reuse that block.
  private func finalMeshJob(at endT: Double, reading: AnchorReading) -> MeshJob {
    var transforms: [UUID: WorldTransform] = [:]
    for anchor in reading.anchors where anchor.kind == .mesh && transforms[anchor.id] == nil {
      transforms[anchor.id] = anchor.transform
    }
    let plan = schedule.takeFinal(at: endT, all: Array(transforms.keys))
    var copies: [MeshCopy] = []
    var reuse: [MeshReuse] = []
    for id in plan.updated {
      guard let transform = transforms[id] else { continue }
      if pendingMeshUpdated.contains(id), let geometry = reading.geometry[id] {
        copies.append(MeshCopy(id: id, transform: transform, geometry: geometry))
      } else {
        reuse.append(MeshReuse(id: id, transform: transform))
      }
    }
    pendingMeshUpdated = []
    return MeshJob(t: endT, final: true, copies: copies, reuse: reuse, removed: plan.removed)
  }

  private func closeWithoutSample(_ reason: WindowEndReason, at t: Double) -> [SinkCommand] {
    switch phase {
    case .armed:
      window.close(at: t, reason: reason)
      return discardArmed()
    case .open, .closing:
      switch window.state {
      case .open(let startT), .closing(let startT, _):
        window.close(at: max(startT, t), reason: reason)
        return finish(readAnchors: noAnchors, sampling: false, fromFrame: false)
      case .waiting, .closed, .discarded:
        return []
      }
    case .finalizing, .closed, .discarded:
      return []
    }
  }

  private func discardArmed() -> [SinkCommand] {
    phase = .discarded
    preOpen.clear()
    return []
  }

  private func discardOpen() -> [SinkCommand] {
    phase = .discarded
    preOpen.clear()
    return [.journal(.discard), .deleteRecording(id: id)]
  }

  /// The degradation ladder at `t`: each step entered is written as an event, then applied.
  /// `no_mesh_history` takes effect through `ladder.keepsMeshHistory`; `no_recording` closes
  /// with `heat` when the phone is critical, else `disk`.
  private func degrade(at t: Double) -> [SinkCommand] {
    guard isLive else { return [] }
    let steps = ladder.update(thermal: thermal, freeDiskBytes: freeDiskBytes)
    guard !steps.isEmpty else { return [] }
    // Stamped no later than the last frame, which is where a close would end the window.
    let stampT = min(t, lastFrame?.t ?? t)
    var lines: [PendingLine] = []
    for step in steps { _ = appendEvent(.degradation(step), t: stampT, to: &lines) }
    var commands: [SinkCommand] = lines.isEmpty ? [] : [.lines(lines)]
    if steps.contains(.noRecording) {
      commands += closeWithoutSample(thermal == .critical ? .heat : .disk, at: stampT)
    }
    return commands
  }

  private func syncLivePhase() {
    switch window.state {
    case .open: phase = .open
    case .closing(_, let deadline): phase = .closing(deadline: deadline)
    case .waiting, .closed, .discarded: break
    }
  }

  // MARK: - Lines

  /// The one way a line gets out: inside the window, and in order within its file. Returns
  /// whether it was kept.
  @discardableResult
  private func admit(_ line: PendingLine, to lines: inout [PendingLine]) -> Bool {
    guard window.accepts(t: line.t) else {
      counts.outsideWindow += 1
      return false
    }
    if let last = lastLineT[line.file] {
      let ordered = Self.sampleStreams.contains(line.file) ? line.t > last : line.t >= last
      guard ordered else {
        counts.nonIncreasing += 1
        return false
      }
    }
    lastLineT[line.file] = line.t
    lines.append(line)
    return true
  }

  private func appendFrameLine(_ s: FrameSample, to lines: inout [PendingLine]) {
    let gap = framesSkipped(previousT: lastFrameLineT, t: s.t, fps: s.fps)
    if admit(.frame(s, gap: gap), to: &lines) { lastFrameLineT = s.t }
  }

  private func appendMotion(_ s: MotionSample, to lines: inout [PendingLine]) {
    guard let frame = manifestBase.motionFrame else { return }
    admit(.motion(s, frame: frame), to: &lines)
  }

  /// The rebaser's zero is the first sample written, so the window and the order are checked
  /// before it sees the sample.
  private func appendAltitude(_ s: AltitudeSample, to lines: inout [PendingLine]) {
    guard window.accepts(t: s.t) else {
      counts.outsideWindow += 1
      return
    }
    if let last = lastLineT[.altitude], !(s.t > last) {
      counts.nonIncreasing += 1
      return
    }
    if let line = rebaser.line(s) { admit(line, to: &lines) }
  }

  /// Returns the `t` the event was stamped with.
  private func appendEvent(_ e: RecordingEvent, t: Double, to lines: inout [PendingLine])
    -> Double
  {
    let stamped = max(t, lastLineT[.events] ?? t)
    admit(.event(e, t: stamped), to: &lines)
    return stamped
  }
}
#endif
