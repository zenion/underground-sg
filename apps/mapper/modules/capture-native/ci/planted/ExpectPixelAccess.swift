// expect: CVPixelBufferGetBaseAddress
import CoreVideo

public func planted(_ buffer: CVPixelBuffer) -> UInt8 {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  return CVPixelBufferGetBaseAddress(buffer)?.load(as: UInt8.self) ?? 0
}
