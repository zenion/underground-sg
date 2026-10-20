import Foundation
import os

/// The last 200 codes the module logged, for `getLogTail()` and the debug card (the lean recorder
/// design, sections 3.3 and 12). A code is a `StaticString`, so nothing but a constant written in
/// this module's source can reach it: no value, pose, time, path or fix. Thread-safe.
final class LogRing: @unchecked Sendable {
  static let shared = LogRing()
  static let capacity = 200

  private let lock = NSLock()
  private var buffer: [String] = []
  /// Where the next code goes once the buffer is full: the oldest one.
  private var next = 0

  func add(_ code: StaticString) {
    let text = code.description
    lock.lock()
    defer { lock.unlock() }
    if buffer.count < Self.capacity {
      buffer.append(text)
    } else {
      buffer[next] = text
      next = (next + 1) % Self.capacity
    }
  }

  /// The codes, oldest first.
  func lines() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    if buffer.count < Self.capacity { return buffer }
    return Array(buffer[next...]) + Array(buffer[..<next])
  }
}

/// Logs a value-free code to the device log (`captureLog`) and to the ring. The code is the only
/// thing in the message, so it alone is `.public`.
func captureNote(_ code: StaticString) {
  captureLog.notice("\(code.description, privacy: .public)")
  LogRing.shared.add(code)
}

/// As `captureNote`, at the error level.
func captureFault(_ code: StaticString) {
  captureLog.error("\(code.description, privacy: .public)")
  LogRing.shared.add(code)
}
