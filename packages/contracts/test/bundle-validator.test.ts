// The bundle validator's checks (docs/capture-bundle.md, "Ingest and validation"), on synthetic
// bundles: each test changes one thing in a valid bundle and expects the specific problem code.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  PROBLEM_CODES,
  type ProblemCode,
  REQUIRED_FILES,
  validateBundle,
  validateBundleTar,
} from "../src/bundle-validator/index.ts";
import {
  BUNDLE_DIR,
  type BundleFiles,
  bundle,
  CAPTURE_ID,
  concat,
  contentFiles,
  editManifest,
  type FixtureSpec,
  fullSpec,
  jpeg,
  jpegSegment,
  jsonl,
  type ManifestWithoutFiles,
  minimalSpec,
  ply,
  plyHeader,
  png,
  removeBundleDirectories,
  text,
  withManifest,
  writeBundleDirectory,
} from "./bundle-fixture.ts";
import { bundleEntries, bundleTar, chunks, writeTar } from "./tar-writer.ts";
import {
  codes,
  expectClean,
  expectProblem,
  problems,
  validateAsDirectory,
  validateAsTar,
} from "./validator-helpers.ts";

afterAll(removeBundleDirectories);

/** A bundle from a changed minimal spec. */
function changed(change: (spec: FixtureSpec) => void, base = minimalSpec()): BundleFiles {
  return bundle(base, change);
}

/** `files` with some files replaced or added, and manifest.files recomputed. */
function replaced(files: BundleFiles, replacements: Record<string, Uint8Array>): BundleFiles {
  const result: BundleFiles = new Map(files);
  for (const [path, bytes] of Object.entries(replacements)) result.set(path, bytes);
  const manifest = JSON.parse(new TextDecoder().decode(result.get("manifest.json"))) as Record<
    string,
    unknown
  >;
  return withManifest(result, manifest);
}

/** `files` without some files; manifest.files still lists them. */
function without(files: BundleFiles, ...paths: string[]): BundleFiles {
  const result: BundleFiles = new Map(files);
  for (const path of paths) result.delete(path);
  return result;
}

/** Frame 1 becomes a third keyframe (0, 1, 3), so one keyframe is not an anchor photo. */
function threeKeyframes(spec: FixtureSpec): void {
  const pose = spec.poses[1];
  if (pose !== undefined) pose.keyframe = true;
  spec.manifest.keyframe_count = 3;
  spec.blur.splice(1, 0, { frame: 1, boxes: [] });
}

describe("a valid bundle", () => {
  test("the minimal bundle passes as a directory, with the facts in info", async () => {
    const report = await validateAsDirectory(bundle());
    expectClean(report);
    expect(report.source).toBe("directory");
    expect(report.capture_id).toBe(CAPTURE_ID);
    expect(report.info).toMatchObject({
      frames: 4,
      keyframes: 2,
      tracking: { normal: 3, limited: 1, not_available: 0 },
      limited_tracking_share: 0.25,
      mesh: { vertices: 5, faces: 3 },
      quarantined_frames: [],
      checks_skipped: [],
    });
  });

  test.each([1, 7, 512, 65_536])(
    "the minimal bundle passes as a tar read in chunks of %i bytes",
    async (chunkSize) => {
      const report = await validateAsTar(bundle(), {}, chunkSize);
      expectClean(report);
      expect(report.source).toBe("tar");
    },
  );

  test("the full bundle (every optional file) passes as a directory and as a tar", async () => {
    const files = bundle(fullSpec());
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        "refined_keyframes.jsonl",
        "imu.jsonl",
        "gnss.jsonl",
        "confidence/000003.png",
        "preview/floorplan.geojson",
      ]),
    );
    expectClean(await validateAsDirectory(files));
    expectClean(await validateAsTar(files));
  });

  test("the order of tar members does not matter", async () => {
    const files = bundle(fullSpec());
    const reversed = writeTar(bundleEntries(files).reverse());
    expectClean(await validateBundleTar(chunks(reversed)));
    const broken = editManifest(files, (manifest) => {
      manifest.frame_count = 9;
    });
    const forward = await validateAsTar(broken);
    const backward = await validateBundleTar(chunks(writeTar(bundleEntries(broken).reverse())));
    expect(backward).toEqual(forward);
  });

  test("a tar without directory entries passes", async () => {
    const entries = bundleEntries(bundle()).filter((entry) => entry.type !== "5");
    expectClean(await validateBundleTar(chunks(writeTar(entries))));
  });

  test("validateBundle reads a directory or a tar file", async () => {
    const files = bundle();
    const directory = writeBundleDirectory(files);
    expectClean(await validateBundle(directory));
    const tarPath = join(directory, "..", "bundle.tar");
    writeFileSync(tarPath, bundleTar(files));
    const report = await validateBundle(tarPath);
    expectClean(report);
    expect(report.source).toBe("tar");
  });

  test("anchor facing within the tolerance passes", async () => {
    const files = changed((spec) => {
      const [start, end] = spec.anchors;
      start.facing = [0.8, 0, 0.6005]; // length 1.0003
      end.facing = [0.6, 0.0009, 0.8];
    });
    expectClean(await validateAsTar(files));
  });
});

describe("missing files", () => {
  const files = bundle();
  const expected: Record<string, ProblemCode> = {
    ...Object.fromEntries(REQUIRED_FILES.map((path) => [path, "file.missing" as ProblemCode])),
    "keyframes/000000.jpg": "keyframe.jpeg_missing",
    "keyframes/000003.jpg": "keyframe.jpeg_missing",
    "depth/000000.png": "keyframe.depth_missing",
    "depth/000003.png": "keyframe.depth_missing",
  };

  test("the minimal bundle has exactly these files", () => {
    expect([...files.keys()].sort()).toEqual(Object.keys(expected).sort());
  });

  test.each(Object.entries(expected))(
    "removing %s fails with a message naming it",
    async (path, code) => {
      for (const report of [
        await validateAsTar(without(files, path)),
        await validateAsDirectory(without(files, path)),
      ]) {
        expect(report.valid).toBe(false);
        const problem = expectProblem(report, code, path);
        expect(problem.message).toContain(path);
        expect(report.failure_reason).toContain(path);
      }
    },
  );

  test.each(Object.entries(expected).filter(([path]) => path !== "manifest.json"))(
    "removing %s and its manifest.files entry fails too",
    async (path, code) => {
      const unlisted = replaced(without(files, path), {});
      const report = await validateAsTar(unlisted);
      expectProblem(report, code, path);
    },
  );

  test("an optional file that is listed but missing fails", async () => {
    const report = await validateAsTar(without(bundle(fullSpec()), "imu.jsonl"));
    expectProblem(report, "files.listed_but_missing", "imu.jsonl");
  });

  test("once one keyframe has a confidence PNG, every keyframe needs one", async () => {
    const files = replaced(without(bundle(fullSpec()), "confidence/000003.png"), {});
    const report = await validateAsTar(files);
    expectProblem(report, "keyframe.confidence_missing", "confidence/000003.png");
  });
});

/** Mutations of the minimal bundle, each expected to give one problem code. */
const cases: Record<
  string,
  () => { files: BundleFiles; code: ProblemCode; file?: string | null; line?: number }
> = {
  "schema_version 2": () => ({
    files: editManifest(bundle(), (manifest) => {
      (manifest as unknown as Record<string, unknown>)["schema_version"] = 2;
    }),
    code: "manifest.schema_version",
    file: "manifest.json",
  }),
  "the bundle directory named after another capture": () => ({
    files: editManifest(bundle(), (manifest) => {
      manifest.capture_id = "0c4f1a2b-3d5e-4f60-8a7b-9c0d1e2f3a4b";
    }),
    code: "bundle.capture_id_mismatch",
    file: BUNDLE_DIR,
  }),
  "anchors.json that is not JSON": () => ({
    files: replaced(bundle(), { "anchors.json": text("[{") }),
    code: "json.invalid",
    file: "anchors.json",
  }),
  "a blank line in poses.jsonl": () => {
    const spec = minimalSpec();
    const lines = spec.poses.map((pose) => JSON.stringify(pose));
    lines.splice(2, 0, "");
    return {
      files: replaced(bundle(), { "poses.jsonl": text(`${lines.join("\n")}\n`) }),
      code: "json.invalid",
      file: "poses.jsonl",
      line: 3,
    };
  },
  "tags.json that is not UTF-8": () => ({
    files: replaced(bundle(), { "tags.json": new Uint8Array([0x5b, 0xff, 0x5d]) }),
    code: "json.invalid",
    file: "tags.json",
  }),
  "tags.json with a byte order mark": () => ({
    files: replaced(bundle(), { "tags.json": text("﻿[]") }),
    code: "json.invalid",
    file: "tags.json",
  }),
  "a node tag with a POI kind": () => ({
    files: changed((spec) => {
      (spec.tags[0] as unknown as Record<string, unknown>)["kind"] = "toilet";
    }),
    code: "schema.invalid",
    file: "tags.json",
  }),
  "a pose line without tracking": () => ({
    files: changed((spec) => {
      delete (spec.poses[2] as Partial<FixtureSpec["poses"][number]>).tracking;
    }),
    code: "schema.invalid",
    file: "poses.jsonl",
    line: 3,
  }),
  "a manifest with an unknown field": () => ({
    files: editManifest(bundle(), (manifest) => {
      (manifest as unknown as Record<string, unknown>)["contributor_id"] = CAPTURE_ID;
    }),
    code: "schema.invalid",
    file: "manifest.json",
  }),
  "a file listed twice": () => ({
    files: editManifest(bundle(), (manifest) => {
      const first = manifest.files[0];
      if (first !== undefined) manifest.files.push(first);
    }),
    code: "files.duplicate_listing",
    file: "manifest.json",
  }),
  "a file not listed in manifest.files": () => {
    const files = new Map(bundle());
    files.set("preview/floorplan.geojson", text('{"type":"FeatureCollection","features":[]}'));
    return { files, code: "files.not_listed", file: "preview/floorplan.geojson" };
  },
  "a file whose size differs from manifest.files": () => {
    const files = new Map(bundle());
    files.set("tags.json", text("[]\n"));
    return { files, code: "files.bytes_mismatch", file: "tags.json" };
  },
  "a file whose SHA-256 differs from manifest.files": () => {
    const files = new Map(bundle());
    const original = files.get("keyframes/000003.jpg") ?? new Uint8Array(0);
    const changedJpeg = original.slice();
    changedJpeg[15] = (changedJpeg[15] ?? 0) ^ 1; // a byte in the JFIF segment
    files.set("keyframes/000003.jpg", changedJpeg);
    return { files, code: "files.sha256_mismatch", file: "keyframes/000003.jpg" };
  },
  "frame_count off by one": () => ({
    files: changed((spec) => {
      spec.manifest.frame_count = 5;
    }),
    code: "manifest.frame_count",
    file: "manifest.json",
  }),
  "keyframe_count off by one": () => ({
    files: changed((spec) => {
      spec.manifest.keyframe_count = 1;
    }),
    code: "manifest.keyframe_count",
    file: "manifest.json",
  }),
  "a keyframe without a blur line": () => ({
    files: changed((spec) => {
      spec.blur = spec.blur.filter((line) => line.frame !== 0);
    }),
    code: "keyframe.blur_line_missing",
    file: "privacy/blur.jsonl",
  }),
  "a JPEG for a frame that is not a keyframe": () => ({
    files: replaced(bundle(), { "keyframes/000001.jpg": jpeg(16, 12) }),
    code: "keyframe.unexpected_file",
    file: "keyframes/000001.jpg",
  }),
  "a depth PNG for a frame not in poses.jsonl": () => ({
    files: replaced(bundle(), { "depth/000009.png": png(256, 192, 16, 1500) }),
    code: "keyframe.unexpected_file",
    file: "depth/000009.png",
  }),
  "a repeated frame in poses.jsonl": () => ({
    files: changed((spec) => {
      const pose = spec.poses[2];
      if (pose !== undefined) pose.frame = 1;
    }),
    code: "order.frame",
    file: "poses.jsonl",
    line: 3,
  }),
  "a repeated t in poses.jsonl": () => ({
    files: changed((spec) => {
      const [, second, third] = spec.poses;
      if (second !== undefined && third !== undefined) third.t = second.t;
    }),
    code: "order.t",
    file: "poses.jsonl",
    line: 3,
  }),
  "t going back in imu.jsonl": () => ({
    files: bundle(fullSpec(), (spec) => {
      const sample = spec.imu?.[3];
      if (sample !== undefined) sample.t = 1.5;
    }),
    code: "order.t",
    file: "imu.jsonl",
    line: 4,
  }),
  "two GNSS fixes with the same t": () => ({
    files: bundle(fullSpec(), (spec) => {
      spec.gnss = [...(spec.gnss ?? []), ...(spec.gnss ?? [])];
    }),
    code: "order.t",
    file: "gnss.jsonl",
    line: 2,
  }),
  "a frame going back in privacy/blur.jsonl": () => ({
    files: changed((spec) => {
      spec.blur.reverse();
    }),
    code: "order.frame",
    file: "privacy/blur.jsonl",
    line: 2,
  }),
  "a refined keyframe line for a frame that is not a keyframe": () => ({
    files: bundle(fullSpec(), (spec) => {
      const first = spec.refined?.[0];
      if (first !== undefined) spec.refined?.splice(1, 0, { frame: 2, transform: first.transform });
    }),
    code: "refined.not_keyframe",
    file: "refined_keyframes.jsonl",
    line: 2,
  }),
  "a tag at a frame not in poses.jsonl": () => ({
    files: changed((spec) => {
      const tag = spec.tags[1];
      if (tag !== undefined) tag.frame = 99;
    }),
    code: "tags.frame_not_in_poses",
    file: "tags.json",
  }),
  "a keyframe that is a PNG": () => ({
    files: replaced(bundle(), { "keyframes/000000.jpg": png(16, 12, 8, 128) }),
    code: "jpeg.invalid",
    file: "keyframes/000000.jpg",
  }),
  "a keyframe JPEG of the wrong size": () => ({
    files: replaced(bundle(), { "keyframes/000003.jpg": jpeg(20, 15) }),
    code: "jpeg.size_mismatch",
    file: "keyframes/000003.jpg",
  }),
  "a depth file that is not a PNG": () => ({
    files: replaced(bundle(), {
      "depth/000000.png": text("not a png at all, just some text here"),
    }),
    code: "png.invalid",
    file: "depth/000000.png",
  }),
  "an 8-bit depth PNG": () => ({
    files: replaced(bundle(), { "depth/000000.png": png(256, 192, 8, 150) }),
    code: "png.format",
    file: "depth/000000.png",
  }),
  "a 16-bit confidence PNG": () => ({
    files: replaced(bundle(fullSpec()), { "confidence/000003.png": png(256, 192, 16, 2) }),
    code: "png.format",
    file: "confidence/000003.png",
  }),
  "a depth PNG of the wrong size": () => ({
    files: replaced(bundle(), { "depth/000003.png": png(128, 96, 16, 1500) }),
    code: "png.size_mismatch",
    file: "depth/000003.png",
  }),
  "image_size and depth_size with different aspect ratios": () => ({
    files: changed((spec) => {
      spec.manifest.depth_size = [256, 144];
    }),
    code: "manifest.aspect_ratio",
    file: "manifest.json",
  }),
  "two start anchors": () => ({
    files: changed((spec) => {
      spec.anchors[1].role = "start";
    }),
    code: "anchors.roles",
    file: "anchors.json",
  }),
  "an anchor photo that is not a keyframe": () => ({
    files: changed((spec) => {
      spec.anchors[0].photo = "keyframes/000001.jpg";
    }),
    code: "anchors.photo_not_keyframe",
    file: "anchors.json",
  }),
  "an anchor photo missing while poses.jsonl is unusable": () => {
    const files = changed((spec) => {
      delete (spec.poses[1] as Partial<FixtureSpec["poses"][number]>).keyframe;
    });
    return { files: without(files, "keyframes/000003.jpg"), code: "anchors.photo_missing" };
  },
  "a facing that is not horizontal": () => ({
    files: changed((spec) => {
      spec.anchors[0].facing = [0, 0.1, -0.995];
    }),
    code: "anchors.facing",
    file: "anchors.json",
  }),
  "a facing that is not of unit length": () => ({
    files: changed((spec) => {
      spec.anchors[1].facing = [0.6, 0, 0.7];
    }),
    code: "anchors.facing",
    file: "anchors.json",
  }),
  "a blur line for a frame that is not a keyframe": () => ({
    files: changed((spec) => {
      spec.blur.splice(1, 0, { frame: 2, boxes: [] });
    }),
    code: "blur.not_keyframe",
    file: "privacy/blur.jsonl",
    line: 2,
  }),
  "a blur box beyond the image's right edge": () => ({
    files: changed((spec) => {
      spec.blur[1]?.boxes.push({ x: 14, y: 0, w: 5, h: 2, kind: "person_head" });
    }),
    code: "blur.box_outside_image",
    file: "privacy/blur.jsonl",
    line: 2,
  }),
  "a blur box below the image": () => ({
    files: changed((spec) => {
      spec.blur[0]?.boxes.push({ x: 0, y: 10, w: 2, h: 3, kind: "person_head" });
    }),
    code: "blur.box_outside_image",
    file: "privacy/blur.jsonl",
    line: 1,
  }),
  "faces_blurred off by one": () => ({
    files: changed((spec) => {
      spec.manifest.privacy.faces_blurred = 2;
    }),
    code: "manifest.faces_blurred",
    file: "manifest.json",
  }),
  "screens_blurred off by one": () => ({
    files: changed((spec) => {
      spec.manifest.privacy.screens_blurred = 0;
    }),
    code: "manifest.screens_blurred",
    file: "manifest.json",
  }),
  "an ASCII PLY": () => ({
    files: replaced(bundle(), {
      "mesh/scene.ply": text(plyHeader(0, 0).replace("binary_little_endian", "ascii")),
    }),
    code: "ply.header",
    file: "mesh/scene.ply",
  }),
  "a PLY header with a comment line": () => ({
    files: replaced(bundle(), {
      "mesh/scene.ply": text(plyHeader(0, 0).replace("ply\n", "ply\ncomment made by ARKit\n")),
    }),
    code: "ply.header",
    file: "mesh/scene.ply",
  }),
  "a PLY header with CRLF line ends": () => ({
    files: replaced(bundle(), { "mesh/scene.ply": text(plyHeader(0, 0).replaceAll("\n", "\r\n")) }),
    code: "ply.header",
    file: "mesh/scene.ply",
  }),
  "a PLY with double vertices": () => ({
    files: replaced(bundle(), {
      "mesh/scene.ply": text(plyHeader(0, 0).replace(/property float/g, "property double")),
    }),
    code: "ply.header",
    file: "mesh/scene.ply",
  }),
  "a PLY cut short": () => {
    const mesh = bundle().get("mesh/scene.ply") ?? new Uint8Array(0);
    return {
      files: replaced(bundle(), { "mesh/scene.ply": mesh.subarray(0, mesh.length - 3) }),
      code: "ply.truncated",
      file: "mesh/scene.ply",
    };
  },
  "a PLY face with a vertex index beyond the vertex count": () => ({
    files: replaced(bundle(), {
      "mesh/scene.ply": ply(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, -1],
        ],
        [{ indices: [0, 1, 3], classification: 2 }],
      ),
    }),
    code: "ply.vertex_index",
    file: "mesh/scene.ply",
  }),
  "a PLY face classification of 8": () => ({
    files: replaced(bundle(), {
      "mesh/scene.ply": ply(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, -1],
        ],
        [{ indices: [0, 1, 2], classification: 8 }],
      ),
    }),
    code: "ply.classification",
    file: "mesh/scene.ply",
  }),
  "a PLY face that is a quad": () => ({
    files: replaced(bundle(), {
      "mesh/scene.ply": ply(
        [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, -1],
          [0, 0, -1],
        ],
        [{ indices: [0, 1, 2, 3], classification: 2 }],
      ),
    }),
    code: "ply.non_triangle_face",
    file: "mesh/scene.ply",
  }),

  // Sizes and orientation (depth_size is fixed; images are in the sensor's landscape orientation)
  "depth_size other than [256, 192], with PNGs of that size": () => ({
    files: changed((spec) => {
      spec.manifest.depth_size = [512, 384];
    }),
    code: "manifest.depth_size",
    file: "manifest.json",
  }),
  "a portrait image_size, with JPEGs of that size": () => ({
    files: changed((spec) => {
      spec.manifest.image_size = [12, 16];
      for (const line of spec.blur) line.boxes = [];
      spec.manifest.privacy.faces_blurred = 0;
      spec.manifest.privacy.screens_blurred = 0;
    }),
    code: "manifest.orientation",
    file: "manifest.json",
  }),
  "a portrait depth_size, with PNGs of that size": () => ({
    files: changed((spec) => {
      spec.manifest.depth_size = [192, 256];
    }),
    code: "manifest.orientation",
    file: "manifest.json",
  }),

  // Image structure
  "a greyscale keyframe JPEG": () => ({
    files: replaced(bundle(), { "keyframes/000000.jpg": jpeg(16, 12, { components: 1 }) }),
    code: "jpeg.format",
    file: "keyframes/000000.jpg",
  }),
  "a keyframe JPEG that ends after its frame header": () => {
    const keyframe = jpeg(16, 12);
    const tables = keyframe.findIndex((byte, i) => byte === 0xff && keyframe[i + 1] === 0xc4);
    return {
      files: replaced(bundle(), { "keyframes/000003.jpg": keyframe.subarray(0, tables) }),
      code: "jpeg.invalid",
      file: "keyframes/000003.jpg",
    };
  },
  "a keyframe JPEG without EOI": () => {
    const keyframe = jpeg(16, 12);
    return {
      files: replaced(bundle(), {
        "keyframes/000003.jpg": keyframe.subarray(0, keyframe.length - 2),
      }),
      code: "jpeg.invalid",
      file: "keyframes/000003.jpg",
    };
  },
  "a second image appended after a keyframe's EOI": () => ({
    files: replaced(bundle(), {
      "keyframes/000003.jpg": concat([jpeg(16, 12), jpeg(1920, 1440)]),
    }),
    code: "jpeg.extra_image",
    file: "keyframes/000003.jpg",
  }),
  "a keyframe JPEG with an Exif thumbnail": () => {
    const keyframe = jpeg(16, 12);
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 10]; // MM, IFD0 empty, IFD1 at 10
    return {
      files: replaced(bundle(), {
        "keyframes/000000.jpg": concat([
          keyframe.subarray(0, 2),
          new Uint8Array(jpegSegment(0xe1, [...text("Exif\0\0"), ...tiff])),
          keyframe.subarray(2),
        ]),
      }),
      code: "jpeg.extra_image",
      file: "keyframes/000000.jpg",
    };
  },
  "a depth PNG with bytes after IEND": () => ({
    files: replaced(bundle(), {
      "depth/000000.png": concat([png(256, 192, 16, 1500), jpeg(16, 12)]),
    }),
    code: "png.trailing_data",
    file: "depth/000000.png",
  }),
  "a depth PNG of only a signature and IHDR": () => ({
    files: replaced(bundle(), { "depth/000003.png": png(256, 192, 16, 1500).subarray(0, 33) }),
    code: "png.invalid",
    file: "depth/000003.png",
  }),
};

describe("checks", () => {
  test.each(Object.keys(cases))("%s", async (name) => {
    const { files, code, file, line } = (cases[name] as (typeof cases)[string])();
    const report = await validateAsTar(files);
    expect(report.valid).toBe(false);
    expectProblem(report, code, file, line);
  });

  test("a bundle of another schema_version reports only that", async () => {
    const files = editManifest(replaced(bundle(), { "tags.json": text("{") }), (manifest) => {
      (manifest as unknown as Record<string, unknown>)["schema_version"] = 2;
      (manifest as unknown as Record<string, unknown>)["new_field"] = true;
    });
    const report = await validateAsTar(files);
    expect(codes(report)).toEqual(["manifest.schema_version"]);
    expect(report.failure_reason).toMatch(
      /^manifest\.schema_version manifest\.json: schema_version is 2/,
    );
  });

  test("schema errors name the field, never the value", async () => {
    const files = changed((spec) => {
      (spec.manifest as unknown as Record<string, unknown>)["contributor_id"] = "secret-value";
    });
    const report = await validateAsTar(files);
    const problem = expectProblem(report, "schema.invalid", "manifest.json");
    expect(problem.message).toContain('"contributor_id"');
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  test("messages leave out t values and GNSS fixes", async () => {
    const files = bundle(fullSpec(), (spec) => {
      spec.gnss = [
        { t: 9.875, lat: 1.2934815, lon: 103.8523107, h_accuracy_m: 4.8 },
        { t: 9.125, lat: 1.2931234, lon: 103.8521234, h_accuracy_m: 999 },
      ];
    });
    const files2 = replaced(files, {
      "gnss.jsonl": text(
        `${new TextDecoder().decode(files.get("gnss.jsonl"))}{"lat": 1.29399999x}\n`,
      ),
    });
    const report = await validateAsTar(files2);
    expectProblem(report, "order.t", "gnss.jsonl", 2);
    expectProblem(report, "json.invalid", "gnss.jsonl", 3);
    const serialised = JSON.stringify(report);
    for (const secret of ["9.875", "9.125", "1.2931234", "103.852", "1.29399999"]) {
      expect(serialised).not.toContain(secret);
    }
  });

  test("a row-major transform is a warning, not an error", async () => {
    const files = changed((spec) => {
      const pose = spec.poses[2];
      if (pose !== undefined) {
        pose.transform = [1, 0, 0, 0.04, 0, 1, 0, 1.4, 0, 0, 1, -1, 0, 0, 0, 1];
      }
    });
    const report = await validateAsTar(files);
    expect(report.valid).toBe(true);
    expectProblem(report, "transform.not_affine", "poses.jsonl", 3);
  });

  test.each<[string, () => BundleFiles, ProblemCode, string]>([
    [
      "ended_at before started_at",
      () =>
        changed((spec) => {
          spec.manifest.ended_at = "2026-10-20T10:31:00+08:00";
        }),
      "manifest.time_order",
      "manifest.json",
    ],
    [
      "a preview that is not JSON",
      () => replaced(bundle(), { "preview/floorplan.geojson": text("<svg/>") }),
      "preview.invalid_json",
      "preview/floorplan.geojson",
    ],
    [
      "a NaN PLY vertex",
      () =>
        replaced(bundle(), {
          "mesh/scene.ply": ply(
            [
              [0, 0, 0],
              [1, Number.NaN, 0],
              [1, 0, -1],
            ],
            [{ indices: [0, 1, 2], classification: 2 }],
          ),
        }),
      "ply.non_finite_vertex",
      "mesh/scene.ply",
    ],
    [
      "bytes after the last PLY face",
      () => {
        const mesh = bundle().get("mesh/scene.ply") ?? new Uint8Array(0);
        const longer = new Uint8Array(mesh.length + 4);
        longer.set(mesh);
        return replaced(bundle(), { "mesh/scene.ply": longer });
      },
      "ply.trailing_bytes",
      "mesh/scene.ply",
    ],
    [
      "a depth PNG with a bad IHDR CRC",
      () => {
        const depth = png(256, 192, 16, 1500);
        depth[29] = (depth[29] ?? 0) ^ 0xff;
        return replaced(bundle(), { "depth/000000.png": depth });
      },
      "png.ihdr_crc",
      "depth/000000.png",
    ],
  ])("%s is a warning", async (_name, build, code, file) => {
    const report = await validateAsTar(build());
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expectProblem(report, code, file);
  });

  test("deeply nested JSON is invalid, without a crash", async () => {
    const deep = text(`${"[".repeat(200_000)}${"]".repeat(200_000)}`);
    const report = await validateAsTar(
      replaced(bundle(), { "tags.json": deep, "preview/floorplan.geojson": deep }),
    );
    expectProblem(report, "schema.invalid", "tags.json");
    expectProblem(report, "preview.invalid_json", "preview/floorplan.geojson");
  });

  test("an empty mesh and empty tags are valid", async () => {
    const files = replaced(
      changed((spec) => {
        spec.tags = [];
      }),
      { "mesh/scene.ply": ply([], []) },
    );
    expectClean(await validateAsTar(files));
  });

  test("the failure reason is the first error, with a count of the rest", async () => {
    const files = changed((spec) => {
      spec.manifest.frame_count = 5;
      spec.manifest.privacy.faces_blurred = 3;
    });
    const report = await validateAsTar(files);
    expect(codes(report)).toEqual(["manifest.frame_count", "manifest.faces_blurred"]);
    expect(report.failure_reason).toBe(
      "manifest.frame_count manifest.json: frame_count is 5, but poses.jsonl has 4 lines (and 1 more errors)",
    );
  });

  test("checks that depend on an unusable poses.jsonl are skipped and said to be", async () => {
    const files = replaced(bundle(), { "poses.jsonl": text("{}\n") });
    const report = await validateAsTar(files);
    expect(codes(report)).toEqual(["schema.invalid"]);
    expect(report.info.frames).toBeNull();
    expect(report.info.limited_tracking_share).toBeNull();
    expect(report.info.checks_skipped.join(" ")).toContain("poses.jsonl");
  });

  test("repeated problems are capped and counted", async () => {
    const files = changed((spec) => {
      const template = spec.poses[0];
      if (template === undefined) return;
      spec.poses = Array.from({ length: 60 }, (_, frame) => ({
        ...template,
        frame,
        t: 1,
        keyframe: frame === 0 || frame === 3,
      }));
      spec.manifest.frame_count = 60;
    });
    const report = await validateAsTar(files);
    const tProblems = problems(report).filter((problem) => problem.code === "order.t");
    expect(tProblems).toHaveLength(20);
    expect(report.omitted).toEqual([{ code: "order.t", file: "poses.jsonl", count: 39 }]);
  });
});

describe("hostile input", () => {
  /** Validates and returns the report and the time taken in milliseconds. */
  async function timed(files: BundleFiles) {
    const started = performance.now();
    const report = await validateAsTar(files, {}, 65_536);
    return { report, ms: performance.now() - started };
  }

  test.each([0, 1, 2, 4, 255])("a PLY face with %i vertex indices is an error", async (count) => {
    const vertices = Array.from({ length: 4 }, (_, i) => [i, 0, 0] as const);
    const faces = [
      { indices: [0, 1, 2], classification: 2 },
      { indices: Array.from({ length: count }, (_, i) => i % 4), classification: 2 },
    ];
    const report = await validateAsTar(
      replaced(bundle(), { "mesh/scene.ply": ply(vertices, faces) }),
    );
    expect(report.valid).toBe(false);
    expect(expectProblem(report, "ply.non_triangle_face", "mesh/scene.ply").message).toMatch(
      /the first is face 1/,
    );
  });

  test("a 1 MiB tags.json of empty objects is rejected quickly", async () => {
    const tags = text(`[${new Array<string>(350_000).fill("{}").join(",")}]`);
    expect(tags.length).toBeGreaterThan(1024 * 1024);
    const { report, ms } = await timed(replaced(bundle(), { "tags.json": tags }));
    expectProblem(report, "schema.invalid", "tags.json");
    expect(ms).toBeLessThan(1000);
  });

  test("a 64 KiB blur line of empty boxes is rejected quickly", async () => {
    const boxes = new Array<string>(21_000).fill("{}").join(",");
    const line = `{"frame":0,"boxes":[${boxes}]}`;
    expect(line.length).toBeGreaterThan(60_000);
    expect(line.length).toBeLessThan(64 * 1024);
    const blur = text(`${line}\n{"frame":3,"boxes":[]}\n`);
    const { report, ms } = await timed(replaced(bundle(), { "privacy/blur.jsonl": blur }));
    expectProblem(report, "schema.invalid", "privacy/blur.jsonl", 1);
    expect(ms).toBeLessThan(1000);
  });

  test("a JSONL file of millions of bad lines stops being parsed after 100", async () => {
    const imu = text("\n".repeat(4_000_000));
    const { report, ms } = await timed(replaced(bundle(fullSpec()), { "imu.jsonl": imu }));
    const lines = problems(report).filter((problem) => problem.file === "imu.jsonl");
    expect(lines).toHaveLength(20);
    expect(report.omitted).toEqual([{ code: "json.invalid", file: "imu.jsonl", count: 80 }]);
    expect(report.info.checks_skipped).toContain(
      "imu.jsonl after line 100: 100 lines are invalid, so the rest is not parsed",
    );
    expect(ms).toBeLessThan(1000);
  });

  test("schema_version is described by type, never echoed", async () => {
    const secret = { lat: 1.2934815, lon: 103.8523107, note: "x".repeat(100_000) };
    for (const [version, shown] of [
      [secret, "an object"],
      ["1", "a string"],
      [[1], "an array"],
      [1.5, "a number that is not an integer"],
    ] as const) {
      const files = editManifest(bundle(), (manifest) => {
        (manifest as unknown as Record<string, unknown>)["schema_version"] = version;
      });
      const report = await validateAsTar(files);
      expect(report.failure_reason).toBe(
        `manifest.schema_version manifest.json: schema_version is ${shown}; this validator reads version 1`,
      );
    }
  });

  test("a bad facing is named by the rule it breaks, never by its values", async () => {
    const files = changed((spec) => {
      spec.anchors[0].facing = [0, 0.1234567, -0.9876543];
    });
    const report = await validateAsTar(files);
    const facing = expectProblem(report, "anchors.facing", "anchors.json");
    expect(facing.message).toBe(
      "Anchor 0 (start): facing is not horizontal (|y| above 0.001) and not of unit length (off by more than 0.001)",
    );
    const length = Math.hypot(0.1234567, -0.9876543);
    const json = JSON.stringify(report);
    for (const value of ["1234", "0.12", "9876", "0.98", length.toFixed(4), length.toFixed(3)]) {
      expect(json, value).not.toContain(value);
    }
  });

  test("an unknown field's name is escaped and cut short in the message", async () => {
    const files = changed((spec) => {
      const pose = spec.poses[0] as unknown as Record<string, unknown>;
      pose["\u009b31mRED\u009b0m"] = 1;
      (spec.manifest as unknown as Record<string, unknown>)["k".repeat(1_000_000)] = 1;
    });
    const report = await validateAsTar(files);
    const pose = expectProblem(report, "schema.invalid", "poses.jsonl", 1);
    expect(pose.message).toBe('the document has an unknown field "\\u{9b}31mRED\\u{9b}0m"');
    const manifest = expectProblem(report, "schema.invalid", "manifest.json");
    expect(manifest.message.length).toBeLessThan(300);
    expect(JSON.stringify(report).length).toBeLessThan(10_000);
  });
});

describe("quarantined frames", () => {
  const spec = minimalSpec();
  threeKeyframes(spec);
  const files = bundle(spec);
  const quarantinedFiles = without(files, "keyframes/000001.jpg", "depth/000001.png");

  test("the fixture with three keyframes is valid", async () => {
    expectClean(await validateAsTar(files));
  });

  test("a stored bundle with a quarantined keyframe's files removed still validates", async () => {
    for (const report of [
      await validateAsTar(quarantinedFiles, { quarantinedFrames: [1] }),
      await validateAsDirectory(quarantinedFiles, { quarantinedFrames: [1] }),
    ]) {
      expectClean(report);
      expect(report.info.quarantined_frames).toEqual([1]);
    }
  });

  test("with confidence PNGs too", async () => {
    const full = fullSpec();
    threeKeyframes(full);
    const removed = without(
      bundle(full),
      "keyframes/000001.jpg",
      "depth/000001.png",
      "confidence/000001.png",
    );
    expectClean(await validateAsTar(removed, { quarantinedFrames: [1] }));
    const kept = without(bundle(full), "keyframes/000001.jpg", "depth/000001.png");
    expectProblem(
      await validateAsTar(kept, { quarantinedFrames: [1] }),
      "quarantine.file_present",
      "confidence/000001.png",
    );
  });

  test("without the quarantine list, the removed files are missing", async () => {
    const report = await validateAsTar(quarantinedFiles);
    expectProblem(report, "keyframe.jpeg_missing", "keyframes/000001.jpg");
    expectProblem(report, "keyframe.depth_missing", "depth/000001.png");
  });

  test("a quarantined keyframe's files must be gone", async () => {
    const report = await validateAsTar(files, { quarantinedFrames: [1] });
    expectProblem(report, "quarantine.file_present", "keyframes/000001.jpg");
    expectProblem(report, "quarantine.file_present", "depth/000001.png");
  });

  test("a quarantined keyframe's files must still be listed", async () => {
    const report = await validateAsTar(replaced(quarantinedFiles, {}), { quarantinedFrames: [1] });
    expectProblem(report, "quarantine.file_not_listed", "keyframes/000001.jpg");
  });

  test("a quarantined frame must be a keyframe", async () => {
    const report = await validateAsTar(quarantinedFiles, { quarantinedFrames: [1, 2] });
    expectProblem(report, "quarantine.not_keyframe", null);
  });

  test("an anchor photo can't be quarantined", async () => {
    const report = await validateAsTar(without(files, "keyframes/000003.jpg", "depth/000003.png"), {
      quarantinedFrames: [3],
    });
    expectProblem(report, "anchors.photo_quarantined", "anchors.json");
  });

  test("quarantined frames must be frame indices", async () => {
    await expect(validateAsTar(files, { quarantinedFrames: [-1] })).rejects.toThrow(TypeError);
    await expect(validateAsTar(files, { quarantinedFrames: [1.5] })).rejects.toThrow(TypeError);
  });
});

describe("documentation", () => {
  test("README.md lists every problem code with its severity", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const [code, info] of Object.entries(PROBLEM_CODES)) {
      expect(readme, code).toContain(`| \`${code}\` | ${info.severity} |`);
    }
  });
});

describe("the fixture", () => {
  test("uses the manifest values the doc describes", () => {
    const manifest = JSON.parse(
      new TextDecoder().decode(bundle().get("manifest.json")),
    ) as ManifestWithoutFiles;
    expect(manifest.image_size).toEqual([16, 12]);
    expect(manifest.depth_size).toEqual([256, 192]);
  });

  test("contentFiles writes one JPEG and depth PNG per keyframe", () => {
    const files = contentFiles(minimalSpec());
    expect([...files.keys()].filter((path) => path.startsWith("keyframes/"))).toEqual([
      "keyframes/000000.jpg",
      "keyframes/000003.jpg",
    ]);
    expect(jsonl([{ a: 1 }])).toEqual(text('{"a":1}\n'));
  });
});
