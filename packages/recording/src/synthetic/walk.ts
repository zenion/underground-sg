// The walk behind the corridor-lean set: a straight 39 m leg along a synthetic underground link,
// from a street door down a ramp to the B1 level, timed as the owner would walk it. Positions are
// in the design frame of @usg/floorplan's synthetic corridor (x along the link, z across it, the
// link from z = 0 to 6) and in the session's ARKit world frame (y up, origin where the camera
// stood when the session started), which is the floor plan's frame shifted to that origin.

import type { Transform } from "@usg/contracts";
import { round } from "../encode.ts";

/** The video format's rate: one ARFrame per slot. */
export const FPS = 60;
/** The start mark at the street door opens the recording. */
export const START_T = 4;
/** The owner stands at the door until then, then walks at WALK_SPEED. */
export const WALK_FROM_T = 6;
export const WALK_SPEED = 1.3;
/** Along the middle of the link's south half, clear of the pillars at z 2.5 to 3.5. */
export const PATH_Z = 1.5;
export const PATH_FROM_X = 0.5;
export const PATH_TO_X = 39.5;
/** Arrival at the far end, where the owner marks the end anchor with End the session here. */
export const END_MARK_T = round(WALK_FROM_T + (PATH_TO_X - PATH_FROM_X) / WALK_SPEED, 3);
/** The margin after End the session here (the design's default, Q2). */
export const MARGIN_S = 5;
/** The recording closes with end_anchor when the margin ends. */
export const END_T = END_MARK_T + MARGIN_S;
/** The camera's height above the floor. */
export const EYE_M = 1.45;
/** The ramp from the street door down to B1: from x 1 to 13, 4.2 m down. */
const RAMP_FROM_X = 1;
const RAMP_TO_X = 13;
const RAMP_DROP_M = 4.2;
/** The walk's frequencies: steps at 1.8 Hz, the body's sway at half that. */
const STEP_HZ = 1.8;

/** The camera's design x at `t`. */
export function cameraX(t: number): number {
  if (t < WALK_FROM_T) return PATH_FROM_X;
  return Math.min(PATH_TO_X, PATH_FROM_X + WALK_SPEED * (t - WALK_FROM_T));
}

export function walking(t: number): boolean {
  return t >= WALK_FROM_T && t < END_MARK_T;
}

/** The floor's height in the world frame at design x: street level, then the ramp, then B1. */
export function floorY(x: number): number {
  const along = Math.min(1, Math.max(0, (x - RAMP_FROM_X) / (RAMP_TO_X - RAMP_FROM_X)));
  return -EYE_M - RAMP_DROP_M * along;
}

/** Maps the design frame to the world frame: the floor plan's rotation, then the origin shift. */
export class Frame {
  /** The floor plan's rotation of the design frame (CorridorMesh.angleRad). */
  readonly angleRad: number;
  private readonly cos: number;
  private readonly sin: number;
  private readonly x0: number;
  private readonly z0: number;

  constructor(angleRad: number) {
    this.angleRad = angleRad;
    this.cos = Math.cos(angleRad);
    this.sin = Math.sin(angleRad);
    // The world origin is the camera at the session start.
    this.x0 = PATH_FROM_X * this.cos - PATH_Z * this.sin;
    this.z0 = PATH_FROM_X * this.sin + PATH_Z * this.cos;
  }

  /** World x and z of a design point. */
  toWorld(x: number, z: number): [number, number] {
    return [x * this.cos - z * this.sin - this.x0, x * this.sin + z * this.cos - this.z0];
  }

  /**
   * Design x and z of a point in the floor plan's frame (the synthetic mesh's x,z pairs), whose
   * translation `offset` the world frame doesn't use.
   */
  fromPlan(x: number, z: number, offset: readonly [number, number]): [number, number] {
    const dx = x - offset[0];
    const dz = z - offset[1];
    return [dx * this.cos + dz * this.sin, -dx * this.sin + dz * this.cos];
  }

  /** A world point from the floor plan's frame: the same rotation, shifted to the origin. */
  planToWorld(x: number, z: number, offset: readonly [number, number]): [number, number] {
    return [x - offset[0] - this.x0, z - offset[1] - this.z0];
  }
}

/** The step's phase since the walk began, in cycles. */
function stepPhase(t: number): number {
  return STEP_HZ * (t - WALK_FROM_T);
}

/** The camera's yaw wobble about its heading, radians. */
function yawWobble(t: number): number {
  return 0.03 * Math.sin(0.7 * t) + (walking(t) ? 0.02 * Math.sin(Math.PI * stepPhase(t)) : 0);
}

/** The camera's pose at `t`: looking along the link (design +x), bobbing as the owner walks. */
export function cameraTransform(frame: Frame, t: number): Transform {
  const x = cameraX(t);
  const bob = walking(t) ? 0.025 * Math.sin(2 * Math.PI * stepPhase(t)) : 0;
  const sway = walking(t) ? 0.02 * Math.sin(Math.PI * stepPhase(t)) : 0;
  const [wx, wz] = frame.toWorld(x, PATH_Z + sway);
  const y = floorY(x) + EYE_M + bob;
  // ARKit's camera looks along its -z axis: z is minus the forward direction, x is right.
  const a = frame.angleRad + yawWobble(t);
  const forward = [Math.cos(a), Math.sin(a)] as const;
  const r = (v: number): number => round(v, 5);
  const p = (v: number): number => round(v, 4);
  return [
    r(-forward[1]),
    0,
    r(forward[0]),
    0,
    0,
    1,
    0,
    0,
    r(-forward[0]),
    0,
    r(-forward[1]),
    0,
    p(wx),
    p(y),
    p(wz),
    1,
  ];
}

/** The camera's height in the world frame at `t`, for the altimeter. */
export function cameraHeight(t: number): number {
  return floorY(cameraX(t)) + EYE_M;
}

/** The step bob's vertical acceleration and its sway, m/s², zero when standing. */
export function walkAcceleration(t: number): [number, number, number] {
  if (!walking(t)) return [0, 0, 0];
  const phase = 2 * Math.PI * stepPhase(t);
  return [0.15 * Math.sin(phase / 2), 0.9 * Math.sin(phase), 0.35 * Math.sin(phase + 1)];
}

/** Rotation rates, rad/s, zero when standing. */
export function walkRotation(t: number): [number, number, number] {
  if (!walking(t)) return [0, 0, 0];
  const phase = 2 * Math.PI * stepPhase(t);
  return [0.05 * Math.sin(phase / 2), 0.021 * Math.cos(0.7 * t), 0.04 * Math.cos(phase / 2)];
}

/** The yaw wobble in degrees, for device motion's heading. */
export function headingWobbleDeg(t: number): number {
  return (yawWobble(t) * 180) / Math.PI;
}
