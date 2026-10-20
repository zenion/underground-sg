// expect: MTLTexture getBytes:
import Metal

public func planted(_ texture: MTLTexture, into bytes: UnsafeMutableRawPointer) {
  texture.getBytes(
    bytes, bytesPerRow: texture.width * 4,
    from: MTLRegionMake2D(0, 0, texture.width, texture.height), mipmapLevel: 0)
}
