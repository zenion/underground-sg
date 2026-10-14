// A synthetic capture bundle, generated in code (no binary blobs in git), for the validator
// tests. Every file is real enough for the validator: JPEGs with a real JFIF/SOF0 structure at
// image_size (a uniform grey baseline colour image), 16-bit and 8-bit greyscale PNGs at depth_size,
// a binary PLY with the documented header, and manifest.files with real sizes and digests. The
// only geographic values are the doc's City Hall GNSS fix and a preview polygon at City Hall MRT.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type {
  BlurLine,
  CaptureAnchors,
  CaptureManifest,
  CaptureTags,
  GnssLine,
  ImuLine,
  PoseLine,
  RefinedKeyframeLine,
  Transform,
} from "../src/index.ts";

export const CAPTURE_ID = "c1a7e0d2-6b3f-4e8a-9d5c-0f2e4b6a8c10";
export const BUNDLE_DIR = `capture-${CAPTURE_ID}`;
/** 16 x 12 has the same aspect ratio as 256 x 192 (and as the phone's 1920 x 1440). */
export const IMAGE_SIZE: [number, number] = [16, 12];
export const DEPTH_SIZE: [number, number] = [256, 192];
export const KEYFRAMES = [0, 3] as const;

/** Bundle files by path inside the bundle directory, manifest.json included. */
export type BundleFiles = Map<string, Uint8Array>;

export type ManifestWithoutFiles = Omit<CaptureManifest, "files">;

export interface FixtureSpec {
  manifest: ManifestWithoutFiles;
  anchors: CaptureAnchors;
  tags: CaptureTags;
  poses: PoseLine[];
  blur: BlurLine[];
  refined: RefinedKeyframeLine[] | null;
  imu: ImuLine[] | null;
  gnss: GnssLine[] | null;
  confidence: boolean;
  preview: boolean;
}

const encoder = new TextEncoder();

export function text(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Camera pose i steps along -z, 1.4 m above the start, column-major. */
function cameraPose(step: number): Transform {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.02 * step, 1.4, -0.5 * step, 1];
}

/** The required files only, with two keyframes (0 and 3) in four frames. */
export function minimalSpec(): FixtureSpec {
  const intrinsics: [number, number, number, number] = [12.04, 12.04, 7.99, 6.02];
  return {
    manifest: {
      schema_version: 1,
      capture_id: CAPTURE_ID,
      app_version: "0.1.0",
      device_model: "iPhone18,2",
      os_version: "iOS 26.6.1",
      session_started_at: "2026-10-20T10:32:01+08:00",
      started_at: "2026-10-20T10:32:03+08:00",
      ended_at: "2026-10-20T10:32:05.250+08:00",
      frame_count: 4,
      keyframe_count: 2,
      image_size: [...IMAGE_SIZE],
      depth_size: [...DEPTH_SIZE],
      drift_m: null,
      privacy: {
        blur_method: "pixelate, 16 px cells, padded box",
        detector_versions: {
          face: "VNDetectFaceRectanglesRequest revision 3",
          person_head: "VNDetectHumanRectanglesRequest revision 2",
          screen: "synthetic test detector 0",
        },
        faces_blurred: 1,
        screens_blurred: 1,
      },
    },
    anchors: [
      {
        role: "start",
        anchor_id: null,
        kind: "floor_point",
        name: "Funan B2 UPL door",
        ordinal: -2,
        point: [0.21, -1.43, -0.86],
        facing: [0, 0, -1],
        transform: cameraPose(0),
        registration: "none",
        photo: "keyframes/000000.jpg",
      },
      {
        role: "end",
        anchor_id: "31d751b1-1605-4791-8d33-77e1ccdfcbd8",
        kind: "image_anchor",
        name: "City Hall exit A gate sign",
        ordinal: -2,
        point: [0.1, 0.62, -1.6],
        facing: [0.6, 0, 0.8],
        transform: [0.8, 0, -0.6, 0, 0.6, 0, 0.8, 0, 0, -1, 0, 0, 0.1, 0.62, -1.6, 1],
        registration: "image_anchor",
        photo: "keyframes/000003.jpg",
      },
    ],
    tags: [
      {
        type: "node",
        kind: "door",
        name: null,
        frame: 1,
        position: [0.02, 0.01, -0.5],
        note: "glass doors, both open",
      },
      { type: "poi", kind: "toilet", name: null, frame: 2, position: [0.04, 0.02, -1], note: null },
    ],
    poses: [0, 1, 2, 3].map((frame) => ({
      frame,
      t: 2 + frame / 30,
      transform: cameraPose(frame),
      intrinsics,
      tracking: frame === 1 ? "limited:excessiveMotion" : "normal",
      keyframe: (KEYFRAMES as readonly number[]).includes(frame),
    })),
    blur: [
      { frame: 0, boxes: [] },
      {
        frame: 3,
        boxes: [
          { x: 2, y: 3, w: 4, h: 4, kind: "face" },
          { x: 1, y: 1, w: 6, h: 8, kind: "person_head" },
          { x: 10, y: 2, w: 5, h: 3, kind: "screen" },
        ],
      },
    ],
    refined: null,
    imu: null,
    gnss: null,
    confidence: false,
    preview: false,
  };
}

/** Every optional file as well: refined keyframes, IMU, GNSS, confidence PNGs, the preview. */
export function fullSpec(): FixtureSpec {
  const spec = minimalSpec();
  spec.refined = KEYFRAMES.map((frame) => ({ frame, transform: cameraPose(frame) }));
  spec.imu = [0, 1, 2, 3, 4].map((i) => ({
    t: 2 + i / 100,
    accel: [0.12, -9.71, -1.05],
    gyro: [0.012, -0.034, 0.005],
  }));
  // The doc's fix at a City Hall street exit.
  spec.gnss = [{ t: 2.05, lat: 1.2934815, lon: 103.8523107, h_accuracy_m: 4.8 }];
  spec.confidence = true;
  spec.preview = true;
  return spec;
}

// Images

/** A JPEG marker segment: FF, the marker, the length (2 + body) and the body. */
export function jpegSegment(marker: number, body: readonly number[]): number[] {
  return [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
}

export interface JpegOptions {
  /** The frame header marker: C0 (baseline, the default), C2 (progressive), ... */
  readonly sof?: number;
  /** 3 for YCbCr colour (the default, as a keyframe must be), 1 for greyscale. */
  readonly components?: 1 | 3;
}

/**
 * A baseline colour JPEG of `width` x `height`: SOI, APP0 (JFIF), DQT, SOF0 with three
 * components (Y, Cb, Cr, no subsampling), two one-symbol Huffman tables, SOS, then every 8 x 8
 * block coded as DC difference 0 and end of block (a uniform mid-grey image), and EOI.
 */
export function jpeg(width: number, height: number, options: JpegOptions = {}): Uint8Array {
  const { sof = 0xc0, components = 3 } = options;
  const ids = Array.from({ length: components }, (_, i) => i + 1);
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8) * components;
  // Two bits per block, both 0; pad the last byte with 1 bits.
  const scanBytes = Math.ceil((blocks * 2) / 8);
  const scan = new Array<number>(scanBytes).fill(0);
  const usedBits = (blocks * 2) % 8;
  if (usedBits > 0) scan[scanBytes - 1] = 0xff >> usedBits;
  const oneSymbolTable = (tableClass: number) => [
    tableClass << 4,
    1,
    ...new Array<number>(15).fill(0),
    0x00,
  ];
  return new Uint8Array([
    0xff,
    0xd8,
    ...jpegSegment(
      0xe0,
      [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0, 0],
    ),
    ...jpegSegment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    ...jpegSegment(sof, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      components,
      ...ids.flatMap((id) => [id, 0x11, 0]),
    ]),
    ...jpegSegment(0xc4, oneSymbolTable(0)),
    ...jpegSegment(0xc4, oneSymbolTable(1)),
    ...jpegSegment(0xda, [components, ...ids.flatMap((id) => [id, 0x00]), 0, 63, 0]),
    ...scan,
    0xff,
    0xd9,
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(text(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A greyscale PNG with every pixel `value`: 16-bit for depth (mm), 8-bit for confidence. */
export function png(width: number, height: number, bitDepth: 8 | 16, value: number): Uint8Array {
  const bytesPerPixel = bitDepth / 8;
  const rowBytes = 1 + width * bytesPerPixel;
  const raw = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * rowBytes + 1 + x * bytesPerPixel;
      if (bitDepth === 16) {
        raw[at] = value >> 8;
        raw[at + 1] = value & 0xff;
      } else {
        raw[at] = value;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = bitDepth;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return concat([
    new Uint8Array(signature),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// Mesh

export interface PlyFace {
  readonly indices: readonly number[];
  readonly classification: number;
}

export function plyHeader(vertices: number, faces: number): string {
  return [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${vertices}`,
    "property float x",
    "property float y",
    "property float z",
    `element face ${faces}`,
    "property list uchar uint vertex_indices",
    "property uchar classification",
    "end_header",
    "",
  ].join("\n");
}

export function ply(
  vertices: readonly (readonly [number, number, number])[],
  faces: readonly PlyFace[],
  header = plyHeader(vertices.length, faces.length),
): Uint8Array {
  const headerBytes = text(header);
  const bodyBytes =
    vertices.length * 12 + faces.reduce((sum, face) => sum + 2 + face.indices.length * 4, 0);
  const out = new Uint8Array(headerBytes.length + bodyBytes);
  out.set(headerBytes);
  const view = new DataView(out.buffer);
  let at = headerBytes.length;
  for (const vertex of vertices) {
    for (const coordinate of vertex) {
      view.setFloat32(at, coordinate, true);
      at += 4;
    }
  }
  for (const face of faces) {
    out[at++] = face.indices.length;
    for (const index of face.indices) {
      view.setUint32(at, index, true);
      at += 4;
    }
    out[at++] = face.classification;
  }
  return out;
}

/** A 1 m floor square (two floor triangles) and one wall triangle. */
export function scenePly(): Uint8Array {
  return ply(
    [
      [0, -1.4, 0],
      [1, -1.4, 0],
      [1, -1.4, -1],
      [0, -1.4, -1],
      [0, 0, -1],
    ],
    [
      { indices: [0, 1, 2], classification: 2 },
      { indices: [0, 2, 3], classification: 2 },
      { indices: [3, 2, 4], classification: 1 },
    ],
  );
}

// Files

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function jsonl(lines: readonly unknown[]): Uint8Array {
  return text(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

export function frameName(frame: number): string {
  return String(frame).padStart(6, "0");
}

/** The bundle's files except manifest.json. */
export function contentFiles(spec: FixtureSpec): BundleFiles {
  const files: BundleFiles = new Map();
  files.set("anchors.json", text(`${JSON.stringify(spec.anchors, null, 2)}\n`));
  files.set("tags.json", text(`${JSON.stringify(spec.tags, null, 2)}\n`));
  files.set("poses.jsonl", jsonl(spec.poses));
  if (spec.refined !== null) files.set("refined_keyframes.jsonl", jsonl(spec.refined));
  if (spec.imu !== null) files.set("imu.jsonl", jsonl(spec.imu));
  if (spec.gnss !== null) files.set("gnss.jsonl", jsonl(spec.gnss));
  const [imageWidth, imageHeight] = spec.manifest.image_size;
  const [depthWidth, depthHeight] = spec.manifest.depth_size;
  for (const pose of spec.poses) {
    if (!pose.keyframe) continue;
    const name = frameName(pose.frame);
    files.set(`keyframes/${name}.jpg`, jpeg(imageWidth, imageHeight));
    files.set(`depth/${name}.png`, png(depthWidth, depthHeight, 16, 1500));
    if (spec.confidence) files.set(`confidence/${name}.png`, png(depthWidth, depthHeight, 8, 2));
  }
  files.set("privacy/blur.jsonl", jsonl(spec.blur));
  files.set("mesh/scene.ply", scenePly());
  if (spec.preview) {
    const preview = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { level: "B1" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [103.8519, 1.2928],
                [103.8524, 1.2928],
                [103.8524, 1.2933],
                [103.8519, 1.2933],
                [103.8519, 1.2928],
              ],
            ],
          },
        },
      ],
    };
    files.set("preview/floorplan.geojson", text(JSON.stringify(preview)));
  }
  return files;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** manifest.files for `files` (everything but manifest.json), sorted by path. */
export function listFiles(files: BundleFiles): CaptureManifest["files"] {
  return [...files.entries()]
    .filter(([path]) => path !== "manifest.json")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
}

/** `files` plus a manifest.json that lists them. */
export function withManifest(
  files: BundleFiles,
  manifest: ManifestWithoutFiles | Record<string, unknown>,
): BundleFiles {
  const result: BundleFiles = new Map(files);
  result.delete("manifest.json");
  const document = { ...manifest, files: listFiles(result) };
  result.set("manifest.json", text(`${JSON.stringify(document, null, 2)}\n`));
  return result;
}

/** A complete, valid bundle from a spec, optionally changed first. */
export function bundle(
  spec: FixtureSpec = minimalSpec(),
  change?: (spec: FixtureSpec) => void,
): BundleFiles {
  change?.(spec);
  return withManifest(contentFiles(spec), spec.manifest);
}

/** Reads manifest.json back, changes it and writes it again (files is not recomputed). */
export function editManifest(
  files: BundleFiles,
  change: (manifest: CaptureManifest) => void,
): BundleFiles {
  const result: BundleFiles = new Map(files);
  const manifest = JSON.parse(
    new TextDecoder().decode(result.get("manifest.json")),
  ) as CaptureManifest;
  change(manifest);
  result.set("manifest.json", text(JSON.stringify(manifest)));
  return result;
}

const temporaryDirectories: string[] = [];

/**
 * Writes the bundle under a new temporary directory; returns the bundle directory's path. Test
 * files that call this remove the directories with `afterAll(removeBundleDirectories)`.
 */
export function writeBundleDirectory(files: BundleFiles, name = BUNDLE_DIR): string {
  const parent = mkdtempSync(join(tmpdir(), "usg-bundle-"));
  temporaryDirectories.push(parent);
  const root = join(parent, name);
  mkdirSync(root);
  for (const [path, bytes] of files) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return root;
}

/** Removes every directory writeBundleDirectory made in this test file. */
export function removeBundleDirectories(): void {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
}
