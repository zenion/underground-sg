// expect: CGImageDestination
import CoreGraphics
import ImageIO

public func planted(_ image: CGImage, to url: CFURL) -> Bool {
  guard let destination = CGImageDestinationCreateWithURL(url, "public.jpeg" as CFString, 1, nil)
  else { return false }
  CGImageDestinationAddImage(destination, image, nil)
  return CGImageDestinationFinalize(destination)
}
