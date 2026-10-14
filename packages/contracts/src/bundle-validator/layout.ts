// The bundle layout (docs/capture-bundle.md, "Layout") and the path rules for tar members and
// directory entries. Files outside the layout are rejected.

import { FRAME_NAME_DIGITS } from "../capture-bundle.ts";
import type { ProblemCode } from "./report.ts";

/** Files every bundle has. Per-keyframe files are checked against poses.jsonl. */
export const REQUIRED_FILES = [
  "manifest.json",
  "anchors.json",
  "tags.json",
  "poses.jsonl",
  "privacy/blur.jsonl",
  "mesh/scene.ply",
] as const;

/** Directories inside the bundle directory. Nothing is nested deeper. */
export const LAYOUT_DIRECTORIES = [
  "keyframes",
  "depth",
  "confidence",
  "privacy",
  "mesh",
  "preview",
] as const;

export type JsonlPath =
  | "poses.jsonl"
  | "refined_keyframes.jsonl"
  | "imu.jsonl"
  | "gnss.jsonl"
  | "privacy/blur.jsonl";

const JSONL_PATHS: readonly JsonlPath[] = [
  "poses.jsonl",
  "refined_keyframes.jsonl",
  "imu.jsonl",
  "gnss.jsonl",
  "privacy/blur.jsonl",
];

/** Directories that hold one file per keyframe, and each one's file extension. */
export const KEYFRAME_DIRECTORIES = {
  keyframes: "jpg",
  depth: "png",
  confidence: "png",
} as const;

export type KeyframeDirectory = keyof typeof KEYFRAME_DIRECTORIES;

/** What a path in the layout holds. */
export type BundleFile =
  | { readonly kind: "manifest" }
  | { readonly kind: "json"; readonly path: "anchors.json" | "tags.json" }
  | { readonly kind: "jsonl"; readonly path: JsonlPath }
  | { readonly kind: "keyframe"; readonly directory: KeyframeDirectory; readonly frame: number }
  | { readonly kind: "ply" }
  | { readonly kind: "preview" };

/** A bundle directory name; the capture_id is the first group. */
export const BUNDLE_DIRECTORY_PATTERN =
  /^capture-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const KEYFRAME_FILE_PATTERN = new RegExp(
  `^(keyframes|depth|confidence)/([0-9]{${FRAME_NAME_DIGITS}})\\.(jpg|png)$`,
);

/** A frame index as a file name: 58 is 000058. */
export function frameName(frame: number): string {
  return String(frame).padStart(FRAME_NAME_DIGITS, "0");
}

/** The path of a keyframe's file: keyframeFilePath("depth", 58) is depth/000058.png. */
export function keyframeFilePath(directory: KeyframeDirectory, frame: number): string {
  return `${directory}/${frameName(frame)}.${KEYFRAME_DIRECTORIES[directory]}`;
}

/** What a path relative to the bundle directory holds, or null if it is outside the layout. */
export function classifyBundlePath(path: string): BundleFile | null {
  if (path === "manifest.json") return { kind: "manifest" };
  if (path === "anchors.json" || path === "tags.json") return { kind: "json", path };
  const jsonl = JSONL_PATHS.find((candidate) => candidate === path);
  if (jsonl !== undefined) return { kind: "jsonl", path: jsonl };
  if (path === "mesh/scene.ply") return { kind: "ply" };
  if (path === "preview/floorplan.geojson") return { kind: "preview" };
  const match = KEYFRAME_FILE_PATTERN.exec(path);
  if (match !== null) {
    const directory = match[1] as KeyframeDirectory;
    if (match[3] !== KEYFRAME_DIRECTORIES[directory]) return null;
    return { kind: "keyframe", directory, frame: Number(match[2]) };
  }
  return null;
}

export type NameCheck =
  | {
      readonly ok: true;
      /** The first segment: the bundle directory, capture-<uuid>. */
      readonly top: string;
      /** The rest, relative to the bundle directory; "" for the bundle directory itself. */
      readonly inner: string;
    }
  | { readonly ok: false; readonly code: ProblemCode; readonly message: string };

export type LayoutCheck =
  | { readonly ok: true; readonly file: BundleFile | null }
  | { readonly ok: false; readonly code: ProblemCode; readonly message: string };

/**
 * Checks a member name (a tar member, or a directory entry joined with /) against the path
 * rules: relative, / separators, no .. or empty segments, printable ASCII. A directory name may
 * end in /. Splits off the first segment, which must be the bundle directory; the caller checks
 * that it is capture-<uuid> and the same for every member.
 */
export function checkMemberName(name: string, isDirectory: boolean): NameCheck {
  let path = name;
  if (path.endsWith("/")) {
    if (!isDirectory) return { ok: false, code: "path.invalid", message: "A file name ends in /" };
    path = path.slice(0, -1);
  }
  if (path === "") return { ok: false, code: "path.invalid", message: "Empty name" };
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code >= 0x7f) {
      return {
        ok: false,
        code: "path.invalid",
        message: "The name has a control or non-ASCII character",
      };
    }
  }
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    return { ok: false, code: "path.absolute", message: "Absolute path: names must be relative" };
  }
  if (path.includes("\\")) {
    return { ok: false, code: "path.backslash", message: "Backslash in the name: use /" };
  }
  const segments = path.split("/");
  if (segments.includes("..")) {
    return { ok: false, code: "path.dot_dot", message: "The name has a .. segment" };
  }
  if (segments.some((segment) => segment === "" || segment === ".")) {
    return {
      ok: false,
      code: "path.not_normalised",
      message: "The name has an empty or . segment",
    };
  }
  if (segments.length === 1 && !isDirectory) {
    return {
      ok: false,
      code: "path.outside_bundle_directory",
      message: "A file outside the capture-<capture_id>/ directory",
    };
  }
  return { ok: true, top: segments[0] ?? "", inner: segments.slice(1).join("/") };
}

/** Checks a path relative to the bundle directory against the layout. */
export function checkLayoutPath(inner: string, isDirectory: boolean): LayoutCheck {
  if (inner === "") return { ok: true, file: null };
  if (isDirectory) {
    return (LAYOUT_DIRECTORIES as readonly string[]).includes(inner)
      ? { ok: true, file: null }
      : {
          ok: false,
          code: "path.outside_layout",
          message: `Directory ${inner}/ is not in the bundle layout`,
        };
  }
  const file = classifyBundlePath(inner);
  return file === null
    ? { ok: false, code: "path.outside_layout", message: `${inner} is not in the bundle layout` }
    : { ok: true, file };
}
