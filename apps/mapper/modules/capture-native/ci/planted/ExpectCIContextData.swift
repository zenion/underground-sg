// expect: CIContext image writer
import CoreImage

public func planted(_ image: CIImage) -> Data? {
  CIContext().jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [:])
}
