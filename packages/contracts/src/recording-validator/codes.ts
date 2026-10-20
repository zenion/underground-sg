// validate-recording's problem codes. Like the bundle validator's PROBLEM_CODES, a code is never
// renamed: `pnpm rec import` and the PC tools match on them. The container codes the tar reader and
// the directory walker produce keep the bundle validator's names, so both tools agree on them.
//
// Messages name files, line numbers, frame indices and counts, never values from poses, samples,
// times, GNSS fixes or boundary values: a recording is personal data, and reports are printed and
// may be read by AI agents (CLAUDE.md, "Privacy").

import { type CodeTable, error, warning } from "../bundle-validator/report.ts";

/**
 * Every problem code, in report order: problems are sorted by their code's position here, then
 * by file and line. Codes starting with `parts.`, `set.`, `tar.`, `entry.`, `path.` or `limits.`
 * are about the container; the rest are about the content.
 */
export const RECORDING_PROBLEM_CODES = {
  // The export's parts
  "parts.names": error("parts.json's part names don't run 0000.part, 0001.part and so on"),
  "parts.part_size": error("A part other than the last is not UPLOAD_PART_BYTES long"),
  "parts.tar_bytes": error("The parts' bytes don't add up to tar_bytes"),
  "parts.missing": error("A part parts.json lists is not in the folder"),
  "parts.bytes_mismatch": error("A part's size differs from parts.json"),
  "parts.sha256_mismatch": error("A part's SHA-256 differs from parts.json"),
  "parts.tar_sha256_mismatch": error("The reassembled tar's SHA-256 differs from tar_sha256"),
  "parts.recording_id_mismatch": error("parts.json's recording_id is not the recording's"),

  // The replay set
  "set.no_recording": error("The replay set has no rec-<recording_id>/ directory"),

  // The container: the tar stream or the directories
  "tar.bad_header": error(
    "A tar header is not a ustar header, or the input is not an uncompressed tar",
  ),
  "tar.bad_checksum": error("A tar header's checksum does not match"),
  "tar.truncated": error(
    "The tar ends inside a header or member, or without its end-of-archive marker",
  ),
  "tar.trailing_data": error("Non-zero bytes after the end-of-archive marker"),
  "tar.unsupported_entry": error("A pax, GNU or other extension header"),
  "entry.link": error("A symbolic or hard link"),
  "entry.special_file": error("A device, FIFO, socket or other file that is not regular"),
  "entry.duplicate": error("Two tar members with the same name"),
  "path.invalid": error(
    "An empty name, a control or non-ASCII character, or a file name ending in /",
  ),
  "path.absolute": error("An absolute path"),
  "path.dot_dot": error("A .. path segment"),
  "path.backslash": error("A backslash in a path"),
  "path.not_normalised": error("An empty or . path segment"),
  "path.outside_set": error(
    "A path that is not under rec-<uuid>/ or a capture-<uuid>/ directory, or a second recording",
  ),
  "path.outside_layout": error("A file or directory that is not in the recording layout"),
  "limits.set_size": error("The replay set's tar is larger than maxExportParts parts"),
  "limits.recording_size": error("The recording is larger than maxRecordingBytes"),
  "limits.entry_count": error("More entries than maxEntries"),
  "limits.file_size": error("A file is larger than the limit for its type"),
  "limits.line_length": error("A JSONL line is longer than maxJsonlLineBytes"),
  "limits.session_length": error(
    "The window is longer than maxSessionSeconds (maxDenseSessionSeconds in dense)",
  ),
  "limits.mesh_block": error(
    "A mesh block inflates to more than maxMeshBlockBytes (12 bytes a vertex, 13 a face)",
  ),
  "limits.image_pixels": error("arkit.video_format has more pixels than maxImagePixels"),

  // recording.json
  "file.missing": error("A required file is missing"),
  "recording.version": error("recording_version is not 1"),
  "recording.id_mismatch": error(
    "The recording directory is not named rec-<recording.json's recording_id>",
  ),
  "json.invalid": error(
    "A JSON file or JSONL line is not valid UTF-8 JSON, or a JSONL line is blank",
  ),
  "schema.invalid": error("A JSON file or JSONL line does not match its schema"),
  "recording.open": error("window.end_t is null: the recording was never closed or recovered"),
  "recording.window_state": error(
    "window.end_t, window.ended and rates are not all null or all set",
  ),
  "recording.window_order": error("window.end_t is before window.start_t"),
  "recording.build_profile": error("build.profile is synthetic but origin isn't, or the reverse"),
  "recording.detector_versions": error(
    "detector_versions is not null in lean, or null in standard or dense",
  ),
  "files.duplicate_listing": error("recording.json's files lists a path twice"),
  "files.listed_but_missing": error("A file listed in files is not in the recording"),
  "files.not_listed": error("A file in the recording is not listed in files"),
  "files.bytes_mismatch": error("A file's size differs from files"),
  "files.sha256_mismatch": error("A file's SHA-256 differs from files"),

  // Segments and the set's bundles
  "segment.duplicate": error("Two segments have the same capture_id"),
  "segment.order": error("A segment's end_t is before its start_t"),
  "segment.hash_without_end": error("A segment has a manifest_sha256 but no end_t"),
  "segment.incomplete": error(
    "In an exported set, a kept segment lacks its end_t or manifest_sha256",
  ),
  "segment.bundle_missing": error("A kept segment's bundle is not in the replay set"),
  "segment.manifest_sha256_mismatch": error(
    "A segment's manifest_sha256 differs from its bundle's manifest.json",
  ),
  "segment.bundle_not_listed": error("A bundle in the set has no kept segment in recording.json"),
  "bundle.invalid": error("A bundle in the set fails validate-bundle (see its own report)"),

  // Lines
  "order.frame": error("frame does not strictly increase within a JSONL file"),
  "order.seq": error("seq does not strictly increase in boundary.jsonl"),
  "order.t": error(
    "t decreases within a JSONL file, or does not strictly increase in a sample stream",
  ),
  "window.outside": error("A line's t is outside the recording's window"),
  "events.detail": error("An event's detail is not what RECORDING_EVENT_DETAILS allows"),
  "actions.plumbing_call": error("actions.jsonl logs one of the recorder's plumbing calls"),
  "json_text.invalid": error("args, result or value is not JSON text"),
  "motion.attitude_norm": error("An attitude quaternion's norm is not within 1e-3 of 1"),
  "motion.heading_arbitrary": error("heading is not null in an arbitrary reference frame"),
  "motion.file_state": error("motion.jsonl is empty but motion isn't null, or the reverse"),

  // Anchor and mesh history
  "history.first_not_add": error("An anchor's first line is not an add"),
  "history.null_fields": error(
    "transform (and offset, bytes, vertices and faces) are not null exactly for remove",
  ),
  "history.capture_id_not_final": error("capture_id is set on a line that isn't final"),
  "history.capture_id_unknown": error("A final line's capture_id is not a segment's"),
  "history.final_not_at_end": error("A final line's t is not window.end_t"),
  "history.final_unexpected": error("Final lines after a close that takes no final sample"),
  "anchors.frame": error("frame is not set exactly for keyframe anchors"),
  "mesh.block_outside_bin": error("A mesh/history.jsonl block lies outside mesh/history.bin"),
  "mesh.block_overlap": error("Two mesh/history.jsonl blocks overlap"),
  "mesh.block_invalid": error(
    "A block is not one raw DEFLATE stream of 12 bytes a vertex plus 13 a face",
  ),
  "mesh.vertex_index": error("A block's face refers to a vertex beyond its vertex count"),
  "mesh.classification": error("A block's face classification is not 0 to 7"),

  // Boundary
  "boundary.value_binary": error("Not exactly one of a boundary line's value and binary is set"),
  "boundary.binary_path": error("binary is not boundary/<seq>.f32 for the line's seq"),
  "boundary.binary_missing": error("A boundary line's binary file is not in the recording"),
  "boundary.unexpected_file": error("A boundary/<seq>.f32 file without a boundary line"),
  "boundary.binary_size": error("A boundary/<seq>.f32 file is not a whole number of float32s"),

  // Candidates
  "candidate.jpeg_missing": error("A kept candidate has no JPEG"),
  "candidate.depth_missing": error("A kept candidate has no depth PNG"),
  "candidate.confidence_missing": error(
    "A kept candidate has no confidence PNG, while others have one",
  ),
  "candidate.blur_line_missing": error("A kept candidate has no privacy/blur.jsonl line"),
  "candidate.unexpected_file": error(
    "A candidate file for a frame that is not a kept candidate, or any in lean",
  ),
  "blur.not_candidate": error("A privacy/blur.jsonl line for a frame that is not a kept candidate"),
  "blur.box_outside_image": error("A blur box extends beyond arkit.video_format"),
  "jpeg.invalid": error(
    "Not a complete JPEG: SOI, a frame header (SOFn), one or more scans (SOS), then EOI",
  ),
  "jpeg.format": error("A candidate JPEG is not 3-component colour"),
  "jpeg.extra_image": error(
    "A candidate JPEG carries a thumbnail (JFIF, JFXX or Exif), an MPF segment or bytes after EOI",
  ),
  "jpeg.size_mismatch": error("A candidate JPEG's size differs from arkit.video_format"),
  "png.invalid": error("Not a complete PNG: a malformed IHDR or chunk, no IDAT or no IEND"),
  "png.trailing_data": error("Bytes after a PNG's IEND chunk"),
  "png.format": error(
    "A depth PNG is not 16-bit greyscale, or a confidence PNG not 8-bit greyscale",
  ),
  "png.size_mismatch": error("A depth or confidence PNG is not 256 x 192"),

  // Warnings
  "json_text.too_large": warning("A JSON text holds the too-large marker instead of its value"),
  "png.ihdr_crc": warning("A PNG's IHDR chunk CRC does not match"),
} as const satisfies CodeTable<string>;

export type RecordingProblemCode = keyof typeof RECORDING_PROBLEM_CODES;
