#if USG_RECORDER
  import ARKit
  import CaptureCore
  import CaptureIO
  import Foundation
  import QuartzCore
  import UIKit

  /// How a session's recording ended, for `stop`'s result.
  enum RecordingOutcome {
    /// Nothing was kept: stopped before the start mark, or without an end anchor, or discarded.
    case none
    /// The recorder closed it and recording.json is final.
    case closed(id: UUID, close: WindowClose)
    /// Writing failed; recovery finishes or removes it at the next launch.
    case failed(id: UUID)

    /// `stop`'s `recording`: null, or `{ id, ended, trimmed, closed }`.
    var value: Any {
      switch self {
      case .closed(let id, let close):
        let value: [String: Any] = [
          "id": id.uuidString.lowercased(), "ended": close.reason.rawValue,
          "trimmed": close.trimmed, "closed": true,
        ]
        return value
      case .none, .failed:
        return NSNull()
      }
    }
  }

  /// One session's recording in the app (the lean recorder design, sections 3.1, 4, 6, 7.5 and
  /// 8): it owns RecorderCore (confined to `Queues.capture`) and its FileSink (confined to
  /// `Queues.recorderIO`), and drives them as SyntheticRecording drives them on the PC.
  ///
  /// - The capture queue: CaptureLoop hands it each ARFrame (a FrameSample, and the anchors and
  ///   mesh geometry RecorderCore asks for, copied inside the callback), marks, tags, stop and
  ///   the session's events; MotionSource's batches and LocationSource's fixes arrive there too.
  ///   RecorderCore's SinkCommands are batched and go to the I/O queue every 100 ms (D9), or at
  ///   once when the batch holds anything but lines. Telemetry once a second (DeviceProbe read
  ///   off the capture queue), and the degradation ladder with it.
  /// - The I/O queue: FileSink applies the commands, with its watermark flush every second and a
  ///   checkpoint every 5 s; its notices come back to the capture queue. The mesh history's
  ///   packing and DEFLATE run inside FileSink there too (CaptureIO's MeshJobRunner), so the
  ///   snapshot is put off while a mesh job is still in flight (`meshQueueIdle`).
  /// - The chained finalize (section 4): when RecorderCore closes the window, the finalize and
  ///   everything after it are held until Core Motion's queue has handed over what it holds, so
  ///   every sample up to `end_t` lands first (`RecorderCore.lateSamples`).
  /// - Main: the sensors, the thermal and memory notifications, and the background task that
  ///   covers a background close.
  ///
  /// Only RecordPermission's grant makes one, so the development build never records. Emits
  /// `recording` on each state change; logs only value-free codes.
  final class RecorderHost: @unchecked Sendable {
    let id: UUID

    private let grant: RecordingGrant
    private let clock: SessionClock
    private let fps: Int
    private let core: RecorderCore
    private let sink: FileSink
    private let motion: MotionSource
    private let probe: DeviceProbe
    private let emit: (String, [String: Any]) -> Void
    private let stopSession: () -> Void
    private let stateChanged: (String) -> Void

    // Capture queue.
    private var started = false
    private var pending: [SinkCommand] = []
    /// From the finalize on, until Core Motion's queue has handed over (the chained finalize).
    private var held: [SinkCommand] = []
    private var holding = false
    private var lastFrameT: Double?
    private var relocalizing = false
    private var stageTimer = StageTimer()
    private var published = ""
    private var waiters: [(RecordingOutcome) -> Void] = []
    private var sinkFailed = false
    private var deletionPending = false
    private var stopSessionAsked = false
    private var batchTimer: DispatchSourceTimer?
    private var telemetryTimer: DispatchSourceTimer?
    private var lastSnapshotMs = 0.0
    private var snapshots = 0

    // I/O queue.
    private var tickTimer: DispatchSourceTimer?
    private var checkpointTimer: DispatchSourceTimer?
    private var ioTimersStopped = false

    // Main queue.
    private var location: LocationSource?
    private var observers: [NSObjectProtocol] = []
    private var sensorsRunning = false
    private var sensorsDone = false

    /// The sink's figures for the debug card, copied on the I/O queue.
    private let figuresLock = NSLock()
    private var sinkFigures: SinkFigures?

    /// Seconds between command batches to the I/O queue (D9).
    static let batchIntervalS = 0.1
    /// TypeScript's final boundary flush is waited for this long after a foreground close.
    static let boundaryWaitS = 1.0

    /// Main queue, at `start`, with the clock read just before `session.run`. Nil unless the grant
    /// is the phone's own (design section 2).
    init?(
      grant: RecordingGrant, base: ManifestBase, fps: Int, motion: MotionSource,
      emit: @escaping (String, [String: Any]) -> Void, stopSession: @escaping () -> Void,
      stateChanged: @escaping (String) -> Void
    ) {
      guard grant.origin == .device, base.origin == .device else { return nil }
      let id = UUID()
      self.id = id
      self.grant = grant
      clock = base.clock
      self.fps = fps
      core = RecorderCore(grant: grant, id: id, config: .lean, manifestBase: base)
      sink = FileSink(store: RecorderPlumbing.shared.store)
      self.motion = motion
      probe = RecorderPlumbing.shared.probe
      self.emit = emit
      self.stopSession = stopSession
      self.stateChanged = stateChanged
    }

    // MARK: - Main queue

    /// The sensors, from `start`: Core Motion, Core Location, and the thermal and memory
    /// notifications. Once only.
    func startSensors() {
      guard !sensorsRunning, !sensorsDone else { return }
      sensorsRunning = true
      motion.start(clock: clock) { [weak self] batch in
        guard let self else { return }
        Queues.capture.async { self.ingest(batch) }
      }
      if location == nil {
        location = LocationSource(grant: grant, clock: clock) { [weak self] fix in
          guard let self else { return }
          Queues.capture.async { self.gnss(fix) }
        }
      }
      location?.start()
      let center = NotificationCenter.default
      observers.append(
        center.addObserver(
          forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
        ) { [weak self] _ in
          guard let self else { return }
          let state = DeviceProbe.deviceThermal(ProcessInfo.processInfo.thermalState)
          Queues.capture.async { self.event(.thermal(state)) }
        })
      observers.append(
        center.addObserver(
          forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
        ) { [weak self] _ in
          guard let self else { return }
          Queues.capture.async { self.event(.memoryWarning) }
        })
    }

    /// When the session stops or the recording closes: the sensors stop and the GNSS ring is
    /// dropped with the recorder. Idempotent.
    func stopSensors() {
      sensorsDone = true
      guard sensorsRunning else { return }
      sensorsRunning = false
      motion.stop()
      location?.stop()
      location = nil
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers.removeAll()
    }

    // MARK: - Capture queue: the session

    /// The session started: the timers run and `recording` says `armed`. Before the first frame.
    func begin() {
      guard !started else { return }
      started = true
      batchTimer = makeTimer(queue: Queues.capture, every: RecorderHost.batchIntervalS) {
        [weak self] in
        self?.flush()
      }
      telemetryTimer = makeTimer(queue: Queues.capture, every: 1) { [weak self] in
        self?.readTelemetry()
      }
      Queues.recorderIO.async { [weak self] in
        guard let self, !self.ioTimersStopped else { return }
        self.tickTimer = makeTimer(queue: Queues.recorderIO, every: 1) { [weak self] in
          guard let self else { return }
          self.handle(self.sink.tick())
        }
        self.checkpointTimer = makeTimer(queue: Queues.recorderIO, every: 5) { [weak self] in
          guard let self else { return }
          self.handle(self.sink.checkpoint())
        }
      }
      publishState()
    }

    /// One ARFrame, inside the delegate callback. `candidate`: the candidate gate passed it.
    func frame(_ frame: ARFrame, index: Int, candidate: Bool, gateMs: Double) {
      guard isFeeding, let t = clock.t(uptime: frame.timestamp) else { return }
      lastFrameT = t
      stageTimer.add(.gate, ms: gateMs, at: t)
      let nowRelocalizing = ARKitAdapter.isRelocalizing(frame.camera.trackingState)
      if nowRelocalizing != relocalizing {
        relocalizing = nowRelocalizing
        take(core.event(nowRelocalizing ? .relocalizationBegan : .relocalizationEnded, t: t))
      }
      let sample = ARKitAdapter.frameSample(
        frame, index: index, t: t, fps: fps, candidate: candidate, gateMs: gateMs)
      let commands = core.frame(sample, position: ARKitAdapter.position(frame)) { request in
        self.read(frame, request)
      }
      take(commands)
    }

    /// A mark handled on `frame`, after its raycast hit and its ARAnchor was added. Returns what
    /// the window is now, for the result: `opened`, `open`, `closing` or `not_open`.
    func marked(_ options: MarkAnchorOptions, frame: ARFrame) -> String {
      let wasArmed = core.phase == .armed
      if isFeeding {
        let input = MarkInput(
          role: options.role == .start ? .start : .end, streetFacing: options.streetFacing,
          endSessionHere: options.endSessionHere)
        take(core.mark(input) { request in self.read(frame, request) })
      }
      switch core.phase {
      case .open: return wasArmed ? "opened" : "open"
      case .closing: return wasArmed ? "opened" : "closing"
      case .armed, .finalizing, .closed, .discarded: return "not_open"
      }
    }

    /// A session call for actions.jsonl: its arguments and what it resolved with, as JSON text,
    /// or its error's code. Kept only while the window is open.
    func recordAction(
      _ call: SessionCall, t: Double, args: [String: Any], result: [String: Any]?, error: String?
    ) {
      guard isLive else { return }
      let input = ActionInput(
        call: call, t: t, args: jsonText(args) ?? "{}", result: result.flatMap(jsonText),
        error: error)
      take(core.action(input))
    }

    /// JavaScript's `stop`, handled on `frame` (the next delegate frame, or `currentFrame` when
    /// none came in time) at `t`: armed, nothing is kept; open, cut back to the last end anchor
    /// plus the margin or discarded; closing, End the session here ends at `t` with a final
    /// sample from `frame`.
    func stop(frame: ARFrame?, t: Double) {
      guard isFeeding else { return }
      recordAction(.stop, t: t, args: [:], result: nil, error: nil)
      stopRequested(frame: frame, t: t)
    }

    /// The session stopped some other way (the view went, the session failed, it was released):
    /// as `stop`, at the last frame. Does nothing once the recording closed.
    func sessionEnded(frame: ARFrame?, t: Double) {
      guard isFeeding else { return }
      stopRequested(frame: frame, t: frame.flatMap { clock.t(uptime: $0.timestamp) } ?? t)
    }

    /// JavaScript's `discard`: nothing of the session is kept. A recording already closed (or
    /// closing for good) is deleted through the store once its files are finished. `done` gets
    /// whether everything was removed.
    func discard(_ done: @escaping (Bool) -> Void) {
      switch core.phase {
      case .armed, .open, .closing:
        take(core.discard())
        whenSettled { outcome in
          if case .failed = outcome {
            done(false)
          } else {
            done(true)
          }
        }
      case .finalizing, .closed:
        whenSettled { [id = self.id] outcome in
          guard case .closed = outcome else {
            done(false)
            return
          }
          Queues.store.async {
            do {
              try RecorderPlumbing.shared.store.delete(id)
              captureNote("recording_discarded")
              done(true)
            } catch {
              done(false)
            }
          }
        }
      case .discarded:
        whenSettled { _ in done(true) }
      }
    }

    /// The boundary trace's lines from TypeScript (plumbing: never in actions.jsonl).
    func boundary(_ lines: [String], final: Bool) {
      take(core.boundary(lines, final: final))
    }

    /// An event at the session time now. RecorderCore keeps it only inside the window.
    func event(_ e: RecordingEvent) {
      guard let t = now() else { return }
      take(core.event(e, t: t))
    }

    func meshUpdated(_ anchor: UUID) {
      core.meshUpdated(anchor)
    }

    func meshRemoved(_ anchor: UUID) {
      core.meshRemoved(anchor)
    }

    /// The app went to the background: an open recording closes as `background` at the last
    /// frame, with no final sample (D1), and `done` runs once its files are finished (or there
    /// was nothing to finish), so the caller's background task can end.
    func closeForBackground(_ done: @escaping () -> Void) {
      if isLive {
        // At the last frame, so the close keeps it.
        let t = lastFrameT ?? now() ?? 0
        take(core.event(.background, t: t))
      }
      if isFeeding {
        take(core.close(at: now() ?? lastFrameT ?? 0, reason: .background))
      }
      whenSettled { _ in done() }
    }

    /// Runs `body` with the outcome once the recording settled: closed and final, discarded and
    /// removed, or failed. At once if it already has.
    func whenSettled(_ body: @escaping (RecordingOutcome) -> Void) {
      if let outcome {
        body(outcome)
      } else {
        waiters.append(body)
      }
    }

    // MARK: - Capture queue: the status

    /// The status event's `recorder`.
    func statusValue() -> [String: Any] {
      var closingInS: Any = NSNull()
      if case .closing(let deadline) = core.phase, let lastFrameT {
        closingInS = max(0, ((deadline - lastFrameT) * 10).rounded() / 10)
      }
      var degradation: Any = NSNull()
      if let step = core.degradationSteps.last { degradation = step.rawValue }
      return [
        "state": published.isEmpty ? "armed" : published, "degradation": degradation,
        "closingInS": closingInS,
      ]
    }

    /// The debug card's recorder figures (design 13): counts, sizes and timings only.
    func debugFigures() -> [String: Any] {
      figuresLock.lock()
      let sinkFigures = self.sinkFigures
      figuresLock.unlock()
      let counts = core.counts
      var figures: [String: Any] = [
        "recOutsideWindow": counts.outsideWindow,
        "recNonIncreasing": counts.nonIncreasing,
        "recBoundaryRefused": counts.boundaryRefused,
        "meshSnapshots": snapshots,
        "meshCopyMs": (lastSnapshotMs * 10).rounded() / 10,
      ]
      if let sink = sinkFigures {
        figures["recCommittedKiB"] = Double(sink.committedBytes / 1024)
        figures["recBacklogKiB"] = Double(sink.backlogBytes / 1024)
        figures["recLinesSkipped"] = sink.linesSkipped
        figures["recLinesRefused"] = sink.linesRefused
        figures["recWriteFailures"] = sink.writeFailures
        figures["recCheckpoints"] = sink.checkpoints
        figures["meshBlocksWritten"] = sink.mesh.written
        figures["meshBlocksReused"] = sink.mesh.reused
        figures["meshBlocksUnchanged"] = sink.mesh.unchanged
        figures["meshBlocksSkipped"] = sink.mesh.skipped
      }
      return figures
    }

    // MARK: - Capture queue: inputs

    private func ingest(_ batch: MotionBatch) {
      if holding {
        // The window has closed; these were taken before the motion queue's barrier, so those
        // up to end_t still belong in it, ahead of the held finalize.
        pending += core.lateSamples(imu: batch.imu, motion: batch.motion, altitude: batch.altitude)
        return
      }
      if !batch.imu.isEmpty { take(core.imu(batch.imu)) }
      if !batch.motion.isEmpty { take(core.motion(batch.motion)) }
      for sample in batch.altitude { take(core.altitude(sample)) }
    }

    private func gnss(_ fix: GnssFix) {
      take(core.gnss(fix))
    }

    /// DeviceProbe reads the phone off the capture queue (free space can take a while to ask),
    /// then the line and the ladder run on it.
    private func readTelemetry() {
      guard isFeeding else { return }
      let probe = self.probe
      let clock = self.clock
      DispatchQueue.global(qos: .utility).async { [weak self] in
        guard let self else { return }
        let reading = probe.read()
        guard let t = clock.t(uptime: ProcessInfo.processInfo.systemUptime) else { return }
        Queues.capture.async {
          guard self.isFeeding else { return }
          let sample = TelemetrySample(
            t: t, thermal: DeviceProbe.deviceThermal(reading.thermal),
            memoryBytes: reading.memoryBytes, cpuPercent: reading.cpuPercent,
            freeDiskBytes: reading.freeDiskBytes, queue: 0, candidatesBlurred: 0,
            candidatesDropped: 0, stageMs: self.stageTimer.percentiles(at: t))
          self.take(self.core.telemetry(sample))
        }
      }
    }

    private func stopRequested(frame: ARFrame?, t: Double) {
      if let frame {
        take(core.stopRequested(frameT: t) { request in self.read(frame, request) })
      } else {
        // No frame to read (the session never delivered one, or has none left): only a closing
        // window reads anchors at the stop, and its final sample then has none to show.
        if case .closing = core.phase { captureFault("recorder_stop_without_frame") }
        take(core.stopRequested(frameT: t) { _ in AnchorReading(anchors: []) })
      }
    }

    /// The anchors and geometry RecorderCore asked for, read from `frame` now.
    private func read(_ frame: ARFrame, _ request: GeometryRequest) -> AnchorReading {
      if case .none = request {
        return ARKitAdapter.reading(frame, request)
      }
      let started = CACurrentMediaTime()
      let reading = ARKitAdapter.reading(frame, request)
      lastSnapshotMs = (CACurrentMediaTime() - started) * 1000
      snapshots += 1
      return reading
    }

    // MARK: - Capture queue: commands to the sink

    /// RecorderCore's commands, in order, towards the sink.
    private func take(_ commands: [SinkCommand]) {
      guard !commands.isEmpty else {
        publishState()
        return
      }
      var urgent = false
      for command in commands {
        switch command {
        case .finalize:
          if !holding {
            holding = true
            startBarrier()
          }
        case .stopSession:
          // End the session here: the ARSession stops at this frame, not when the I/O queue
          // gets to the command behind the final mesh snapshot.
          if !stopSessionAsked {
            stopSessionAsked = true
            stopSession()
          }
        case .deleteRecording:
          deletionPending = true
        case .createRecording, .lines, .mesh, .journal, .registerCut, .boundaryFlushed:
          break
        }
        // Lines wait for the next batch; anything else goes now, with what is before it.
        if case .lines = command {} else { urgent = true }
        if holding {
          held.append(command)
        } else {
          pending.append(command)
        }
      }
      if urgent { flush() }
      publishState()
    }

    /// Sends what is pending to the I/O queue.
    private func flush() {
      guard !pending.isEmpty else { return }
      let batch = pending
      pending = []
      let carriesMesh = batch.contains { command in
        if case .mesh = command { return true }
        return false
      }
      if carriesMesh { core.meshQueueIdle = false }
      Queues.recorderIO.async {
        let notices = self.sink.apply(batch)
        if carriesMesh {
          Queues.capture.async { self.core.meshQueueIdle = true }
        }
        self.handle(notices)
      }
    }

    /// The chained finalize (design section 4): Core Motion's queue hands over what it holds,
    /// then the held finalize goes to the sink behind those samples.
    private func startBarrier() {
      motion.barrier { [weak self] in
        guard let self else { return }
        Queues.capture.async { self.releaseHeld() }
      }
    }

    private func releaseHeld() {
      guard holding else { return }
      holding = false
      pending += held
      held = []
      flush()
      // The recording has closed: nothing more to sense for it.
      DispatchQueue.main.async { self.stopSensors() }
    }

    // MARK: - I/O queue: the sink's notices

    private func handle(_ notices: [SinkNotice]) {
      let figures = sink.figures
      figuresLock.lock()
      sinkFigures = figures
      figuresLock.unlock()
      for notice in notices {
        switch notice {
        case .closeRequested(let reason):
          captureNote("recorder_sink_close_requested")
          Queues.capture.async { self.take(self.core.sinkLimitReached(reason)) }
        case .finalized:
          if sink.state == .protectionPending {
            // Locked: the files go to class A when the phone is unlocked (or at the next launch).
            RecorderPlumbing.shared.holdUntilProtected(self)
          }
          Queues.capture.async {
            self.core.finalizeCompleted()
            self.publishState()
          }
        case .awaitingBoundary:
          Queues.recorderIO.asyncAfter(deadline: .now() + RecorderHost.boundaryWaitS) {
            self.handle(self.sink.boundaryWaitExpired())
          }
        case .deleted:
          Queues.capture.async {
            self.deletionPending = false
            self.publishState()
          }
        case .failed:
          captureFault("recorder_sink_failed")
          Queues.capture.async {
            self.sinkFailed = true
            self.publishState()
          }
        case .stopSession:
          // Already asked for when RecorderCore gave the command.
          break
        }
      }
      if sink.state != .open && sink.state != .empty && sink.state != .awaitingBoundary {
        stopIOTimers()
      }
    }

    /// The phone was unlocked while the files waited for class A. I/O queue work.
    func protectedDataBecameAvailable() {
      Queues.recorderIO.async {
        self.handle(self.sink.protectedDataBecameAvailable())
        if self.sink.state != .protectionPending {
          RecorderPlumbing.shared.releaseProtectionHold(self)
        }
      }
    }

    private func stopIOTimers() {
      ioTimersStopped = true
      tickTimer?.cancel()
      tickTimer = nil
      checkpointTimer?.cancel()
      checkpointTimer = nil
    }

    // MARK: - Capture queue: state

    /// Armed, open or closing: frames and samples go to RecorderCore.
    private var isFeeding: Bool {
      guard !sinkFailed else { return false }
      switch core.phase {
      case .armed, .open, .closing: return true
      case .finalizing, .closed, .discarded: return false
      }
    }

    /// Open or closing: lines can be written.
    private var isLive: Bool {
      guard !sinkFailed else { return false }
      switch core.phase {
      case .open, .closing: return true
      case .armed, .finalizing, .closed, .discarded: return false
      }
    }

    private var outcome: RecordingOutcome? {
      if sinkFailed { return .failed(id: id) }
      switch core.phase {
      case .closed(let close): return .closed(id: id, close: close)
      case .discarded: return deletionPending ? nil : RecordingOutcome.none
      case .armed, .open, .closing, .finalizing: return nil
      }
    }

    /// Emits `recording` when the state changed, and runs whoever waits for the outcome.
    private func publishState() {
      var payload: [String: Any] = [:]
      let state: String
      if sinkFailed {
        state = "failed"
        payload["code"] = "ERR_IO"
      } else {
        switch core.phase {
        case .armed:
          state = "armed"
        case .open:
          state = "open"
          if case .open(let startT) = core.windowState { payload["startT"] = startT }
        case .closing:
          state = "closing"
        case .finalizing:
          state = "finalizing"
        case .closed(let close):
          state = "closed"
          payload["ended"] = close.reason.rawValue
          payload["trimmed"] = close.trimmed
          payload["closed"] = true
        case .discarded:
          state = "discarded"
        }
      }
      if state != published {
        published = state
        payload["t"] = now() ?? lastFrameT ?? 0
        payload["state"] = state
        emit("recording", payload)
        stateChanged(state)
        RecorderHost.note(state)
      }
      if let outcome, !waiters.isEmpty {
        let ready = waiters
        waiters = []
        for body in ready { body(outcome) }
      }
      if outcome != nil { finishTimers() }
    }

    /// The recording settled: the capture queue's timers stop, and the sensors with them.
    private func finishTimers() {
      guard batchTimer != nil || telemetryTimer != nil else { return }
      flush()
      batchTimer?.cancel()
      batchTimer = nil
      telemetryTimer?.cancel()
      telemetryTimer = nil
      Queues.recorderIO.async { self.stopIOTimers() }
      DispatchQueue.main.async { self.stopSensors() }
    }

    private func now() -> Double? {
      clock.t(uptime: ProcessInfo.processInfo.systemUptime)
    }

    private static func note(_ state: String) {
      switch state {
      case "armed": captureNote("recorder_armed")
      case "open": captureNote("recorder_open")
      case "closing": captureNote("recorder_closing")
      case "finalizing": captureNote("recorder_finalizing")
      case "closed": captureNote("recorder_closed")
      case "discarded": captureNote("recorder_discarded")
      default: captureFault("recorder_failed")
      }
    }
  }

  /// A repeating timer on `queue`, started.
  private func makeTimer(
    queue: DispatchQueue, every seconds: Double, _ handler: @escaping () -> Void
  ) -> DispatchSourceTimer {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(
      deadline: .now() + seconds, repeating: seconds,
      leeway: .milliseconds(max(1, Int(seconds * 100))))
    timer.setEventHandler(handler: handler)
    timer.resume()
    return timer
  }

  /// JSON text for actions.jsonl (sorted keys, bounded as JsonText), or nil when the value isn't
  /// JSON (a non-finite number): never an Objective-C exception.
  func jsonText(_ value: [String: Any]) -> String? {
    guard JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
      let text = String(data: data, encoding: .utf8)
    else { return nil }
    return JsonText.bounded(text)
  }

  /// The background task that covers a background close (design 7.5): begun on the main queue
  /// when the scene enters the background, ended when the recording settled or iOS's time ran
  /// out (recovery then finishes from the journal). Main queue only.
  final class BackgroundClose: @unchecked Sendable {
    private var task: UIBackgroundTaskIdentifier = .invalid

    static func begin() -> BackgroundClose {
      let close = BackgroundClose()
      close.task = UIApplication.shared.beginBackgroundTask(withName: "usg.recorder.close") {
        [weak close] in
        close?.end()
      }
      return close
    }

    func end() {
      guard task != .invalid else { return }
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
  }
#endif
