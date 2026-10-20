// expect: PHPhotoLibrary
import Photos

public func planted() {
  PHPhotoLibrary.shared().performChanges({}, completionHandler: nil)
}
