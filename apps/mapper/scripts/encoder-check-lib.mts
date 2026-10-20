// The encoder check's rules (ADR 0010, "One image path, enforced by the compiler"): what an
// object file of the capture module must not reference outside the allowed places. Pure, so
// Vitest covers the rules on any OS; encoder-check.mts reads the objects with Xcode's tools.
//
// It reads two things, because Swift calls an Objective-C method through objc_msgSend and leaves
// only the selector's name in the object: the undefined symbols (C functions, Swift functions,
// Objective-C class references) and the Objective-C method names the object uses.

export interface Rule {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Matched against each undefined symbol as the object names it (C names start with `_`). */
export const SYMBOL_RULES: readonly Rule[] = [
  { name: "CGImageDestination", pattern: /^_CGImageDestination/ },
  { name: "UIImageJPEGRepresentation", pattern: /^_UIImageJPEGRepresentation$/ },
  { name: "UIImagePNGRepresentation", pattern: /^_UIImagePNGRepresentation$/ },
  { name: "UIImageHEICRepresentation", pattern: /^_UIImageHEICRepresentation$/ },
  { name: "UIGraphicsImageRenderer", pattern: /^_OBJC_CLASS_\$_UIGraphicsImageRenderer/ },
  {
    name: "UIGraphics image context",
    pattern: /^_UIGraphicsGetImageFromCurrentImageContext$|^_UIGraphicsBeginImageContext/,
  },
  { name: "AVAssetWriter", pattern: /^_OBJC_CLASS_\$_AVAssetWriter/ },
  { name: "VTCompressionSession", pattern: /^_VTCompressionSession/ },
  { name: "CVPixelBufferGetBaseAddress", pattern: /^_CVPixelBufferGetBaseAddress(?:OfPlane)?$/ },
  { name: "CGDataProviderCopyData", pattern: /^_CGDataProviderCopyData$/ },
  { name: "CGBitmapContextGetData", pattern: /^_CGBitmapContextGetData$/ },
  { name: "vImage", pattern: /^_vImage/ },
  { name: "PHPhotoLibrary", pattern: /^_OBJC_CLASS_\$_PHPhotoLibrary$/ },
  { name: "PHAssetCreationRequest", pattern: /^_OBJC_CLASS_\$_PHAsset(?:Creation|Change)Request$/ },
  { name: "UIImageWriteToSavedPhotosAlbum", pattern: /^_UIImageWriteToSavedPhotosAlbum$/ },
  {
    name: "UISaveVideoAtPathToSavedPhotosAlbum",
    pattern: /^_UISaveVideoAtPathToSavedPhotosAlbum$/,
  },
];

/** Matched against each undefined symbol after `swift-demangle`: Swift's own names for them. */
export const SWIFT_RULES: readonly Rule[] = [
  { name: "UIImage.jpegData", pattern: /\bUIImage\.jpegData\(/ },
  { name: "UIImage.pngData", pattern: /\bUIImage\.pngData\(/ },
  { name: "UIImage.heicData", pattern: /\bUIImage\.heicData\(/ },
  { name: "ARView.snapshot", pattern: /\bRealityKit\.ARView\.snapshot\(/ },
  { name: "UIGraphicsImageRenderer", pattern: /\bUIGraphicsImageRenderer\b/ },
  { name: "CGImageDestination", pattern: /\bCGImageDestination/ },
  { name: "AVAssetWriter", pattern: /\bAVAssetWriter\b/ },
  { name: "PHPhotoLibrary", pattern: /\bPHPhotoLibrary\b/ },
  { name: "vImage", pattern: /\bvImage\b/ },
];

/** Matched against each Objective-C selector the object uses. */
export const SELECTOR_RULES: readonly Rule[] = [
  // CIContext's writers: JPEG, PNG, HEIF, HEIF10, TIFF and OpenEXR, as data or to a URL.
  { name: "CIContext image writer", pattern: /RepresentationOfImage:/ },
  { name: "CIContext render:toBitmap:", pattern: /^render:toBitmap:/ },
  { name: "MTLTexture getBytes:", pattern: /^getBytes:bytesPerRow:/ },
  {
    name: "UIView drawViewHierarchyInRect:",
    pattern: /^drawViewHierarchyInRect:afterScreenUpdates:$/,
  },
  { name: "CALayer renderInContext:", pattern: /^renderInContext:$/ },
  { name: "Photos album writer", pattern: /ToSavedPhotosAlbum/ },
];

export interface ObjectContents {
  /** `<module>/<object file name>`, the allow-list's key. */
  readonly object: string;
  readonly undefinedSymbols: readonly string[];
  /** The same symbols demangled, in the same order. */
  readonly demangled: readonly string[];
  readonly selectors: readonly string[];
}

export interface Finding {
  readonly object: string;
  readonly kind: "symbol" | "selector";
  readonly rule: string;
  readonly name: string;
}

/** Allowed rules per object: `{ "CaptureBlur/Blur.o": ["CGImageDestination", ...] }`. */
export type AllowList = Readonly<Record<string, readonly string[]>>;

export function findViolations(contents: ObjectContents, allow: AllowList = {}): Finding[] {
  const allowed = new Set(allow[contents.object] ?? []);
  const findings = new Map<string, Finding>();
  const add = (kind: Finding["kind"], rule: Rule, name: string): void => {
    if (allowed.has(rule.name)) return;
    findings.set(`${kind}:${rule.name}:${name}`, {
      object: contents.object,
      kind,
      rule: rule.name,
      name,
    });
  };

  contents.undefinedSymbols.forEach((symbol, index) => {
    for (const rule of SYMBOL_RULES) if (rule.pattern.test(symbol)) add("symbol", rule, symbol);
    const demangled = contents.demangled[index] ?? symbol;
    for (const rule of SWIFT_RULES)
      if (rule.pattern.test(demangled)) add("symbol", rule, demangled);
    // Objective-C selector stubs (objc_msgSend$<selector>), which clang can emit.
    const stub = /^_objc_msgSend\$(.+)$/.exec(symbol);
    if (stub?.[1]) {
      for (const rule of SELECTOR_RULES)
        if (rule.pattern.test(stub[1])) add("selector", rule, stub[1]);
    }
  });
  for (const selector of contents.selectors) {
    for (const rule of SELECTOR_RULES)
      if (rule.pattern.test(selector)) add("selector", rule, selector);
  }
  return [...findings.values()];
}

/** `nm -u -j`: one undefined symbol per line. */
export function parseSymbols(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith(":"));
}

/**
 * `otool -v -s __TEXT __objc_methname`: a header, then one string per line after its address.
 * An object without the section prints only the file name.
 */
export function parseMethodNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^[0-9a-f]{8,16}\s+(\S.*)$/i.exec(line);
    if (match?.[1]) names.push(match[1].trim());
  }
  return names;
}

export function describeFinding(finding: Finding): string {
  return `${finding.object}: ${finding.kind} ${finding.name} (${finding.rule})`;
}
