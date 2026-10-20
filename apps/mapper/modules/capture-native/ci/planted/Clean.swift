// Uses the same frameworks without writing, encoding or reading pixels: must pass.
import CoreImage
import CoreVideo
import RealityKit
import UIKit

@MainActor public func planted(_ buffer: CVPixelBuffer) -> (Int, Int, Bool) {
  let image = CIImage(cvPixelBuffer: buffer)
  _ = CIContext(options: nil)
  let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
  view.debugOptions = [.showSceneUnderstanding]
  return (CVPixelBufferGetWidth(buffer), Int(image.extent.height), UIImage(named: "x") == nil)
}
