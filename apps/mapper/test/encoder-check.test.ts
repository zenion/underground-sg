// The encoder check's rules and parsers (scripts/encoder-check-lib.mts). The macOS CI job runs
// the check itself on the compiled module and on planted calls; this covers the matching on any OS.

import { describe, expect, test } from "vitest";
import {
  findViolations,
  type ObjectContents,
  parseMethodNames,
  parseSymbols,
} from "../scripts/encoder-check-lib.mts";

const object = (overrides: Partial<ObjectContents>): ObjectContents => ({
  object: "CaptureNative/CaptureView.o",
  undefinedSymbols: [],
  demangled: [],
  selectors: [],
  ...overrides,
});

const rules = (contents: ObjectContents, allow = {}) =>
  findViolations(contents, allow).map((finding) => finding.rule);

describe("symbols", () => {
  test.each([
    ["_CGImageDestinationCreateWithURL", "CGImageDestination"],
    ["_CGImageDestinationFinalize", "CGImageDestination"],
    ["_UIImageJPEGRepresentation", "UIImageJPEGRepresentation"],
    ["_UIImagePNGRepresentation", "UIImagePNGRepresentation"],
    ["_OBJC_CLASS_$_UIGraphicsImageRenderer", "UIGraphicsImageRenderer"],
    ["_OBJC_CLASS_$_UIGraphicsImageRendererFormat", "UIGraphicsImageRenderer"],
    ["_UIGraphicsGetImageFromCurrentImageContext", "UIGraphics image context"],
    ["_OBJC_CLASS_$_AVAssetWriter", "AVAssetWriter"],
    ["_OBJC_CLASS_$_AVAssetWriterInput", "AVAssetWriter"],
    ["_VTCompressionSessionCreate", "VTCompressionSession"],
    ["_CVPixelBufferGetBaseAddress", "CVPixelBufferGetBaseAddress"],
    ["_CVPixelBufferGetBaseAddressOfPlane", "CVPixelBufferGetBaseAddress"],
    ["_CGDataProviderCopyData", "CGDataProviderCopyData"],
    ["_CGBitmapContextGetData", "CGBitmapContextGetData"],
    ["_vImageBuffer_InitWithCVPixelBuffer", "vImage"],
    ["_OBJC_CLASS_$_PHPhotoLibrary", "PHPhotoLibrary"],
    ["_OBJC_CLASS_$_PHAssetCreationRequest", "PHAssetCreationRequest"],
    ["_UIImageWriteToSavedPhotosAlbum", "UIImageWriteToSavedPhotosAlbum"],
    ["_UISaveVideoAtPathToSavedPhotosAlbum", "UISaveVideoAtPathToSavedPhotosAlbum"],
  ])("%s is refused (%s)", (symbol, rule) => {
    expect(rules(object({ undefinedSymbols: [symbol], demangled: [symbol] }))).toContain(rule);
  });

  test("Swift names are matched after demangling", () => {
    const contents = object({
      undefinedSymbols: [
        "_$s10RealityKit6ARViewC8snapshot9saveToHDR10completionySb_ySo7UIImageCSgctFTj",
        "_$sSo7UIImageC5UIKitE7pngData10Foundation4DataVSgyF",
      ],
      demangled: [
        "dispatch thunk of RealityKit.ARView.snapshot(saveToHDR: Swift.Bool, completion: (__C.UIImage?) -> ()) -> ()",
        "(extension in UIKit):__C.UIImage.pngData() -> Foundation.Data?",
      ],
    });
    expect(rules(contents)).toEqual(["ARView.snapshot", "UIImage.pngData"]);
  });

  test("what the capture view uses passes", () => {
    const used = [
      "_OBJC_CLASS_$_ARWorldTrackingConfiguration",
      "_OBJC_CLASS_$_UITextField",
      "_OBJC_CLASS_$_UIImage",
      "_CVPixelBufferGetWidth",
      "_CVPixelBufferGetHeight",
      "_$s10RealityKit6ARViewC5frame10cameraMode30automaticallyConfigureSessionACSo6CGRectV_AC06CameraF0OSbtcfC",
      "_objc_msgSend",
      "_swift_retain",
    ];
    expect(
      rules(
        object({
          undefinedSymbols: used,
          demangled: used,
          selectors: ["init", "setIsSecureTextEntry:", "runWithConfiguration:options:", "pause"],
        }),
      ),
    ).toEqual([]);
  });
});

describe("selectors", () => {
  test.each([
    ["JPEGRepresentationOfImage:colorSpace:options:", "CIContext image writer"],
    ["PNGRepresentationOfImage:format:colorSpace:options:", "CIContext image writer"],
    ["HEIFRepresentationOfImage:format:colorSpace:options:", "CIContext image writer"],
    ["HEIF10RepresentationOfImage:colorSpace:options:error:", "CIContext image writer"],
    ["writeJPEGRepresentationOfImage:toURL:colorSpace:options:error:", "CIContext image writer"],
    [
      "writePNGRepresentationOfImage:toURL:format:colorSpace:options:error:",
      "CIContext image writer",
    ],
    ["render:toBitmap:rowBytes:bounds:format:colorSpace:", "CIContext render:toBitmap:"],
    ["getBytes:bytesPerRow:fromRegion:mipmapLevel:", "MTLTexture getBytes:"],
    ["drawViewHierarchyInRect:afterScreenUpdates:", "UIView drawViewHierarchyInRect:"],
    ["renderInContext:", "CALayer renderInContext:"],
  ])("%s is refused (%s)", (selector, rule) => {
    expect(rules(object({ selectors: [selector] }))).toEqual([rule]);
  });

  test("selector stubs count too", () => {
    const stub = "_objc_msgSend$JPEGRepresentationOfImage:colorSpace:options:";
    expect(rules(object({ undefinedSymbols: [stub], demangled: [stub] }))).toEqual([
      "CIContext image writer",
    ]);
  });
});

describe("the allow-list", () => {
  test("allows only the listed rules in the listed object", () => {
    const contents = object({
      object: "CaptureBlur/Blur.o",
      undefinedSymbols: ["_CGImageDestinationCreateWithURL", "_OBJC_CLASS_$_PHPhotoLibrary"],
      demangled: ["_CGImageDestinationCreateWithURL", "_OBJC_CLASS_$_PHPhotoLibrary"],
    });
    expect(rules(contents, { "CaptureBlur/Blur.o": ["CGImageDestination"] })).toEqual([
      "PHPhotoLibrary",
    ]);
    expect(
      rules(
        { ...contents, object: "CaptureNative/CaptureView.o" },
        {
          "CaptureBlur/Blur.o": ["CGImageDestination"],
        },
      ),
    ).toEqual(["CGImageDestination", "PHPhotoLibrary"]);
  });
});

describe("parsers", () => {
  test("nm -u -j", () => {
    expect(parseSymbols("_objc_msgSend\n_OBJC_CLASS_$_UIView\r\n\n")).toEqual([
      "_objc_msgSend",
      "_OBJC_CLASS_$_UIView",
    ]);
  });

  test("otool -v -s __TEXT __objc_methname", () => {
    const output = [
      "/tmp/dd/CaptureView.o:",
      "Contents of (__TEXT,__objc_methname) section",
      "0000000000000000  init",
      "0000000000000005  runWithConfiguration:options:",
      "0000000000000023  JPEGRepresentationOfImage:colorSpace:options:",
    ].join("\n");
    expect(parseMethodNames(output)).toEqual([
      "init",
      "runWithConfiguration:options:",
      "JPEGRepresentationOfImage:colorSpace:options:",
    ]);
    expect(parseMethodNames("/tmp/dd/Clean.o:\n")).toEqual([]);
  });
});
