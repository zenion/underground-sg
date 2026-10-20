// UUIDv5 (RFC 9562) and SHA-256 with node:crypto, for the synthetic sets' ids and files lists.

import { createHash } from "node:crypto";
import type { SetDigests } from "../synthetic/corridor-lean.ts";

/**
 * The namespace of every synthetic set's UUIDs: a fixed random UUID, so ids stay the same across
 * runs and never collide with a phone's (random v4) ids.
 */
export const SYNTHETIC_NAMESPACE = "5b0d6c1e-8f3a-4d27-9e41-c2a7f0b3d958";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The UUIDv5 of `name` in `namespace`, lowercase. */
export function uuidV5(name: string, namespace = SYNTHETIC_NAMESPACE): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const NODE_DIGESTS: SetDigests = { uuid: (name) => uuidV5(name), sha256: sha256Hex };
