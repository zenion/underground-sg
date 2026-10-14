// Douglas-Peucker simplification of closed rings, and ring areas.

/**
 * Simplifies a closed ring given as flat x, y pairs (first vertex not repeated). Vertices further
 * than `tolerance` from the simplified outline are kept; with tolerance 0 only exactly collinear
 * vertices go. The ring is split at its first vertex and the vertex furthest from it, and each
 * half is simplified with an explicit stack (no recursion, so long rings are safe on Hermes'
 * smaller stack). Returns fewer than 3 vertices when the ring collapses.
 */
export function simplifyRing(coords: readonly number[], tolerance: number): number[] {
  const n = coords.length / 2;
  if (n < 3) return coords.slice();
  const x0 = coords[0]!;
  const y0 = coords[1]!;
  let far = 0;
  let farDistance = -1;
  for (let i = 1; i < n; i++) {
    const dx = coords[2 * i]! - x0;
    const dy = coords[2 * i + 1]! - y0;
    const d = dx * dx + dy * dy;
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  // keep[n] stands for vertex 0 again, closing the ring.
  const keep = new Uint8Array(n + 1);
  keep[0] = 1;
  keep[far] = 1;
  keep[n] = 1;
  const limit = tolerance * tolerance;
  const stack: number[] = [0, far, far, n];
  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    if (end - start < 2) continue;
    const ax = coords[2 * start]!;
    const ay = coords[2 * start + 1]!;
    const e = end === n ? 0 : end;
    const bx = coords[2 * e]!;
    const by = coords[2 * e + 1]!;
    const abx = bx - ax;
    const aby = by - ay;
    const length2 = abx * abx + aby * aby;
    let worst = -1;
    let worstDistance = -1;
    for (let i = start + 1; i < end; i++) {
      const px = coords[2 * i]! - ax;
      const py = coords[2 * i + 1]! - ay;
      let d: number;
      if (length2 === 0) {
        d = px * px + py * py;
      } else {
        // Distance to the segment, not the infinite line, so a ring that doubles back is safe.
        let t = (px * abx + py * aby) / length2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const qx = px - t * abx;
        const qy = py - t * aby;
        d = qx * qx + qy * qy;
      }
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worstDistance > limit) {
      keep[worst] = 1;
      stack.push(start, worst, worst, end);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i] !== 0) out.push(coords[2 * i]!, coords[2 * i + 1]!);
  }
  return out;
}

/**
 * Signed area of a flat x, y ring in the grid or the session's x/z plane, as seen from above
 * (looking down the y axis): positive when the ring runs counter-clockwise from above. With x to
 * the right, z points down the page when seen from above, so this is minus the usual shoelace sum.
 */
export function flatRingArea(coords: readonly number[]): number {
  const n = coords.length / 2;
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    sum += coords[2 * j]! * coords[2 * i + 1]! - coords[2 * i]! * coords[2 * j + 1]!;
  }
  return -sum / 2;
}

/** Reverses a flat x, y ring in place. */
export function reverseRing(coords: number[]): void {
  for (let i = 0, j = coords.length - 2; i < j; i += 2, j -= 2) {
    const x = coords[i]!;
    const y = coords[i + 1]!;
    coords[i] = coords[j]!;
    coords[i + 1] = coords[j + 1]!;
    coords[j] = x;
    coords[j + 1] = y;
  }
}
