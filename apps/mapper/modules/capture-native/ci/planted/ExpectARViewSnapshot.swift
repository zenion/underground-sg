// expect: ARView.snapshot
import RealityKit
import UIKit

@MainActor public func planted(_ view: ARView) {
  view.snapshot(saveToHDR: false) { _ in }
}
