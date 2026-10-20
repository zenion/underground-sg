#if USG_RECORDER
  import CaptureCore
  import CaptureIO
  import Darwin
  import Foundation

  /// What the phone's state is, for telemetry.jsonl once a second, the degradation ladder and
  /// the debug card (the lean recorder design, sections 5, 6 and 13): heat, the app's memory
  /// footprint, its CPU use, free space and Low Power Mode. Counts and states only.
  ///
  /// Every read is safe from any queue. Free space comes from the shared RecordingStore, which
  /// asks for `volumeAvailableCapacityForImportantUsage` at most once a second.
  final class DeviceProbe: @unchecked Sendable {
    struct Reading: Equatable {
      var thermal: ProcessInfo.ThermalState
      /// `phys_footprint`, in bytes; 0 when the kernel didn't answer.
      var memoryBytes: Int64
      /// The largest footprint this probe has read.
      var peakMemoryBytes: Int64
      /// The app's threads' CPU use, in percent of one core (it can pass 100); 0 when unknown.
      var cpuPercent: Double
      var freeDiskBytes: Int64
      var lowPowerMode: Bool
    }

    private let store: RecordingStore
    private let lock = NSLock()
    private var peak: Int64 = 0

    init(store: RecordingStore) {
      self.store = store
    }

    func read() -> Reading {
      let memory = DeviceProbe.memoryFootprint() ?? 0
      lock.lock()
      peak = max(peak, memory)
      let peakNow = peak
      lock.unlock()
      return Reading(
        thermal: ProcessInfo.processInfo.thermalState, memoryBytes: memory,
        peakMemoryBytes: peakNow, cpuPercent: DeviceProbe.cpuPercent() ?? 0,
        freeDiskBytes: store.freeBytes(),
        lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    /// CaptureCore's heat level for telemetry and the ladder. An unknown future state counts as
    /// the worst, so the ladder errs towards closing.
    static func deviceThermal(_ state: ProcessInfo.ThermalState) -> DeviceThermal {
      switch state {
      case .nominal: return .nominal
      case .fair: return .fair
      case .serious: return .serious
      case .critical: return .critical
      @unknown default: return .critical
      }
    }

    /// The app's memory footprint as iOS counts it against its limit (`phys_footprint` from
    /// TASK_VM_INFO), or nil.
    static func memoryFootprint() -> Int64? {
      var info = task_vm_info_data_t()
      var count = mach_msg_type_number_t(
        MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
      let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
          task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), raw, &count)
        }
      }
      guard result == KERN_SUCCESS else { return nil }
      return Int64(info.phys_footprint)
    }

    /// The sum of the app's threads' CPU use (`thread_info`, THREAD_BASIC_INFO), idle threads
    /// left out, in percent of one core, or nil.
    static func cpuPercent() -> Double? {
      var threadList: thread_act_array_t?
      var threadCount = mach_msg_type_number_t(0)
      guard task_threads(mach_task_self_, &threadList, &threadCount) == KERN_SUCCESS,
        let threads = threadList
      else { return nil }
      defer {
        for index in 0..<Int(threadCount) {
          mach_port_deallocate(mach_task_self_, threads[index])
        }
        vm_deallocate(
          mach_task_self_, vm_address_t(UInt(bitPattern: threads)),
          vm_size_t(Int(threadCount) * MemoryLayout<thread_t>.stride))
      }
      var total = 0.0
      for index in 0..<Int(threadCount) {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(
          MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
          pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
            thread_info(threads[index], thread_flavor_t(THREAD_BASIC_INFO), raw, &count)
          }
        }
        guard result == KERN_SUCCESS, info.flags & TH_FLAGS_IDLE == 0 else { continue }
        total += Double(info.cpu_usage) / Double(TH_USAGE_SCALE) * 100
      }
      return (total * 10).rounded() / 10
    }
  }
#endif
