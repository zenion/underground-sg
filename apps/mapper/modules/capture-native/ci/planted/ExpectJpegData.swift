// expect: UIImageJPEGRepresentation | UIImage.jpegData
import UIKit

public func planted(_ image: UIImage) -> Data? {
  image.jpegData(compressionQuality: 0.9)
}
