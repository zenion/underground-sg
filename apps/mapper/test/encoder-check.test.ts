// The encoder check's rules and parsers (scripts/encoder-check-lib.mts). The macOS CI job runs
// the check itself on the compiled module and on planted calls; this covers the matching on any OS.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  allowListKeysOutside,
  findViolations,
  machOSection,
  methodNames,
  type ObjectContents,
  parseSymbols,
  podNames,
} from "../scripts/encoder-check-lib.mts";

describe("which pods are checked", () => {
  test("every pod the capture module lists", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../modules/capture-native/expo-module.config.json", import.meta.url),
        "utf8",
      ),
    );
    expect(podNames(config)).toEqual(["CaptureNative", "CaptureCore"]);
    expect(podNames({ apple: { podspecPath: "ios/Only.podspec" } })).toEqual(["Only"]);
    expect(() => podNames({ apple: {} })).toThrow(/podspecPath/);
  });

  test("an allow-list entry for a pod that isn't checked is reported", () => {
    const allow = { "CaptureBlur/Blur.o": ["CGImageDestination"], "CaptureNative/A.o": [] };
    expect(allowListKeysOutside(allow, ["CaptureNative", "CaptureCore"])).toEqual([
      "CaptureBlur/Blur.o",
    ]);
  });

  test("the committed allow-list names only checked pods", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../modules/capture-native/expo-module.config.json", import.meta.url),
        "utf8",
      ),
    );
    const allow = JSON.parse(
      readFileSync(
        new URL("../modules/capture-native/encoder-allowlist.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, string[]>;
    const entries = Object.fromEntries(
      Object.entries(allow).filter(([key]) => !key.startsWith("$")),
    );
    expect(allowListKeysOutside(entries, podNames(config))).toEqual([]);
  });
});

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

  test("keeps selector stubs, which end in a colon", () => {
    // What Xcode 26's Swift left in the planted MTLTexture.getBytes object, as nm printed it.
    const output = [
      "__swift_FORCE_LOAD_$_swiftMetal",
      "_objc_msgSend$getBytes:bytesPerRow:fromRegion:mipmapLevel:",
      "_objc_msgSend$height",
      "_objc_msgSend$width",
    ].join("\n");
    const symbols = parseSymbols(output);
    expect(symbols).toHaveLength(4);
    expect(rules(object({ undefinedSymbols: symbols, demangled: symbols }))).toEqual([
      "MTLTexture getBytes:",
    ]);
  });

  test("the Objective-C method names of a Mach-O object file", () => {
    const strings =
      "init\0runWithConfiguration:options:\0JPEGRepresentationOfImage:colorSpace:options:\0";
    const file = machO([
      ["__TEXT", "__text", new Uint8Array([0x1f, 0x20, 0x03, 0xd5])],
      ["__TEXT", "__objc_methname", new TextEncoder().encode(strings)],
      ["__DATA", "__objc_methname", new TextEncoder().encode("decoy\0")],
    ]);
    expect(methodNames(file)).toEqual([
      "init",
      "runWithConfiguration:options:",
      "JPEGRepresentationOfImage:colorSpace:options:",
    ]);
    expect([...(machOSection(file, "__TEXT", "__text") ?? [])]).toEqual([0x1f, 0x20, 0x03, 0xd5]);
    expect(machOSection(file, "__TEXT", "__cstring")).toBeNull();
    expect(methodNames(machO([["__TEXT", "__text", new Uint8Array(4)]]))).toEqual([]);
  });

  test("refuses what isn't a 64-bit Mach-O file", () => {
    expect(() => methodNames(new Uint8Array(64))).toThrow(/Mach-O/);
    const truncated = machO([["__TEXT", "__objc_methname", new TextEncoder().encode("init\0")]]);
    expect(() => methodNames(truncated.subarray(0, truncated.length - 3))).toThrow(/past the file/);
  });
});

/** A minimal arm64 object file: one LC_SEGMENT_64 holding the given sections, then their bytes. */
function machO(sections: [segment: string, section: string, bytes: Uint8Array][]): Uint8Array {
  const commandSize = 72 + 80 * sections.length;
  const dataStart = 32 + commandSize;
  const total = dataStart + sections.reduce((sum, [, , bytes]) => sum + bytes.length, 0);
  const file = new Uint8Array(total);
  const view = new DataView(file.buffer);
  const name = (offset: number, text: string) => file.set(new TextEncoder().encode(text), offset);
  view.setUint32(0, 0xfeedfacf, true); // MH_MAGIC_64
  view.setUint32(4, 0x0100000c, true); // CPU_TYPE_ARM64
  view.setUint32(12, 1, true); // MH_OBJECT
  view.setUint32(16, 1, true); // one load command
  view.setUint32(20, commandSize, true);
  view.setUint32(32, 0x19, true); // LC_SEGMENT_64, with an empty segment name
  view.setUint32(36, commandSize, true);
  view.setUint32(32 + 64, sections.length, true);
  let data = dataStart;
  sections.forEach(([segment, section, bytes], index) => {
    const base = 32 + 72 + index * 80;
    name(base, section);
    name(base + 16, segment);
    view.setBigUint64(base + 40, BigInt(bytes.length), true);
    view.setUint32(base + 48, data, true);
    file.set(bytes, data);
    data += bytes.length;
  });
  return file;
}
