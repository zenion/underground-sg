// The examples from docs/capture-bundle.md, as typed values. Synthetic: no venue recording.
// The doc's "[16 floats]" placeholders are filled in with real column-major 4x4 transforms.

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

/** Device pose at the start anchor tap: yawed 30 degrees about y, 1.4 m above the floor. */
const tapPose: Transform = [
  0.866025, 0, -0.5, 0, 0, 1, 0, 0, 0.5, 0, 0.866025, 0, 0.35, 0.02, 0.41, 1,
];

/**
 * ARImageAnchor on a sign facing [0.6, 0, 0.8]: x along the sign, y out of the sign (its normal),
 * z down the sign, origin at the anchor's point.
 */
const signPose: Transform = [
  0.8, 0, -0.6, 0, 0.6, 0, 0.8, 0, 0, -1, 0, 0, -41.37, 0.62, -148.95, 1,
];

/** Camera pose at frame 123, looking along -z with a small yaw. */
const framePose: Transform = [
  0.998, 0, 0.0628, 0, 0, 1, 0, 0, -0.0628, 0, 0.998, 0, 0.12, 0.01, -0.52, 1,
];

export const manifest: CaptureManifest = {
  schema_version: 1,
  capture_id: "8f9585da-8554-4b8a-ba4e-0f390ccd3802",
  app_version: "0.1.0",
  device_model: "iPhone18,2",
  os_version: "iOS 26.6.1",
  session_started_at: "2026-10-20T10:32:01+08:00",
  started_at: "2026-10-20T10:32:03+08:00",
  ended_at: "2026-10-20T10:34:41+08:00",
  frame_count: 4210,
  keyframe_count: 312,
  image_size: [1920, 1440],
  depth_size: [256, 192],
  drift_m: 0.42,
  privacy: {
    blur_method: "pixelate, 16 px cells, padded box",
    detector_versions: {
      face: "VNDetectFaceRectanglesRequest, with the revision in use",
      person_head: "VNDetectHumanRectanglesRequest, with the revision in use",
      screen: "model and version chosen in the Phase 1 spike",
    },
    faces_blurred: 17,
    screens_blurred: 3,
  },
  files: [
    {
      path: "anchors.json",
      bytes: 1184,
      sha256: "197129aec34bcd1814b9f325984f4fc47efee8a39bafc0f6d2f8e304a0f2699e",
    },
    {
      path: "keyframes/000058.jpg",
      bytes: 412377,
      sha256: "57d87741e18680df32b3ecd630bc33709651bb5fa3811d048879880283db054a",
    },
    {
      path: "poses.jsonl",
      bytes: 1893502,
      sha256: "cc20b39e0fb0a7719594ab29e0cb53bac2e8384e525fbc8768ba968ba30f7fd6",
    },
  ],
};

export const anchors: CaptureAnchors = [
  {
    role: "start",
    anchor_id: "bac5bc30-e4b3-44f0-a134-04168e65db9e",
    kind: "floor_point",
    name: "Funan B2 UPL door",
    ordinal: -2,
    point: [0.21, -1.43, -0.86],
    facing: [0.0, 0.0, -1.0],
    transform: tapPose,
    registration: "world_map",
    photo: "keyframes/000058.jpg",
  },
  {
    role: "end",
    anchor_id: "31d751b1-1605-4791-8d33-77e1ccdfcbd8",
    kind: "image_anchor",
    name: "City Hall exit A gate sign",
    ordinal: -2,
    point: [-41.37, 0.62, -148.95],
    facing: [0.6, 0.0, 0.8],
    transform: signPose,
    registration: "image_anchor",
    photo: "keyframes/004187.jpg",
  },
];

export const tags: CaptureTags = [
  {
    type: "node",
    kind: "escalator",
    name: null,
    frame: 1832,
    position: [-14.62, 0.04, -61.08],
    note: "up only, B2 to B1",
  },
  {
    type: "poi",
    kind: "toilet",
    name: null,
    frame: 2675,
    position: [-27.15, 0.02, -97.33],
    note: null,
  },
];

export const poseLine: PoseLine = {
  frame: 123,
  t: 4.104,
  transform: framePose,
  intrinsics: [1445.2, 1445.2, 958.4, 721.9],
  tracking: "normal",
  keyframe: true,
};

export const refinedKeyframeLine: RefinedKeyframeLine = {
  frame: 123,
  transform: [0.998, 0, 0.0628, 0, 0, 1, 0, 0, -0.0628, 0, 0.998, 0, 0.13, 0.01, -0.51, 1],
};

export const imuLine: ImuLine = {
  t: 4.104,
  accel: [0.12, -9.71, -1.05],
  gyro: [0.012, -0.034, 0.005],
};

/** A fix at a City Hall street exit (the doc's example). */
export const gnssLine: GnssLine = {
  t: 171.35,
  lat: 1.2934815,
  lon: 103.8523107,
  h_accuracy_m: 4.8,
};

export const blurLines: BlurLine[] = [
  { frame: 58, boxes: [] },
  {
    frame: 812,
    boxes: [
      { x: 1204, y: 388, w: 96, h: 112, kind: "face" },
      { x: 1188, y: 352, w: 132, h: 150, kind: "person_head" },
      { x: 402, y: 905, w: 180, h: 104, kind: "screen" },
    ],
  },
];
