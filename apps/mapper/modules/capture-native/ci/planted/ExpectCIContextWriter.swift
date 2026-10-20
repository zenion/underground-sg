// expect: CIContext image writer
import CoreImage

public func planted(_ image: CIImage, to url: URL) throws {
  let context = CIContext()
  try context.writeJPEGRepresentation(
    of: image, to: url, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:])
}
