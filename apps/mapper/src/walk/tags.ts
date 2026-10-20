// The walk screen's minimal tag row (the lean design's Q7): one button per node kind the mapper
// passes on the corridor (docs/spec.md, "Capture flow", step 3). POIs come with the full capture.
// Connector kinds (escalator, lift, stairs, travelator, ramp) mark one landing each
// (docs/capture-bundle.md, tags.json).

import type { NodeKind } from "@usg/contracts";
import type { AddTagOptions } from "../../modules/capture-native/src/types.ts";

export interface NodeTagButton {
  readonly kind: NodeKind;
  readonly label: string;
}

/** In the order the row shows them. Junctions are drawn later, not tagged while walking. */
export const NODE_TAG_ROW: readonly NodeTagButton[] = Object.freeze([
  { kind: "exit", label: "Exit" },
  { kind: "entrance", label: "Entrance" },
  { kind: "door", label: "Door" },
  { kind: "escalator", label: "Escalator" },
  { kind: "stairs", label: "Stairs" },
  { kind: "lift", label: "Lift" },
  { kind: "travelator", label: "Travelator" },
  { kind: "ramp", label: "Ramp" },
  { kind: "fare_gate", label: "Fare gate" },
]);

export function isNodeTagKind(kind: string): kind is NodeKind {
  return NODE_TAG_ROW.some((button) => button.kind === kind);
}

/** What the screen passes to `addTag` for a button: a node, unnamed (names come from the review). */
export function nodeTagOptions(kind: NodeKind): AddTagOptions {
  return { type: "node", kind, name: null };
}
