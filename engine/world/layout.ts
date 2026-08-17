import * as THREE from 'three';

/**
 * Single source of truth for arena dimensions. Every subsystem (bowl geometry,
 * crowd sampling, lighting rig, camera shots) derives from these numbers so the
 * whole venue stays coherent when you tune it.
 *
 * Units are metres. The stage sits at negative X; the audience faces +X → -X.
 * The bowl is an ellipse: radius `r` is scaled by `ellipse.a` on X, `ellipse.b` on Z.
 */
export const ARENA = {
  /** Angular resolution of every ring in the venue. */
  segments: 168,
  ellipse: { a: 1.3, b: 1.0 },

  /** Flat general-admission floor, in un-scaled radius units. */
  floorR: 44,

  /**
   * Seating decks, from the pitch outward. `r0`/`y0` are the first row's
   * radius and height; each subsequent row steps out by `tread` and up by `rise`.
   */
  tiers: [
    { rows: 22, r0: 46, y0: 2.6, tread: 0.98, rise: 0.52 },
    { rows: 26, r0: 74, y0: 16.2, tread: 1.02, rise: 0.74 },
    { rows: 20, r0: 108, y0: 38.0, tread: 1.06, rise: 0.9 },
  ],

  stage: {
    cx: -46, // centre of the stage deck on X
    depth: 20, // extent along X
    width: 34, // extent along Z
    deckY: 2.4, // deck top surface height
    thrustTo: -16, // catwalk tip, pushing into the floor crowd
    thrustWidth: 6,
  },

  roof: { rInner: 132, rOuter: 152, y: 62 },
} as const;

export const STAGE_FRONT = ARENA.stage.cx + ARENA.stage.depth / 2; // -36
export const STAGE_CENTER = new THREE.Vector3(ARENA.stage.cx, ARENA.stage.deckY, 0);
/** Where performers stand, and what most audience cameras point at. */
export const STAGE_FOCUS = new THREE.Vector3(STAGE_FRONT - 3, ARENA.stage.deckY + 2.4, 0);
/** Centre of mass of the standing floor crowd. */
export const FLOOR_FOCUS = new THREE.Vector3(6, 1.2, 0);

const _v = new THREE.Vector3();

/** Point on an elliptical ring of radius `r` at angle `theta`. */
export function ringPoint(r: number, theta: number, out = _v): THREE.Vector3 {
  return out.set(
    r * ARENA.ellipse.a * Math.cos(theta),
    0,
    r * ARENA.ellipse.b * Math.sin(theta),
  );
}

/**
 * How full a given bearing is. theta = PI points at the stage, where real
 * venues kill or curtain the seats, so density collapses there.
 */
export function crowdDensityAt(theta: number): number {
  const facing = 0.5 + 0.5 * Math.cos(theta); // 1 = opposite the stage, 0 = behind it
  return 0.1 + 0.9 * Math.pow(facing, 0.55);
}

export type SeatSlot = {
  position: THREE.Vector3;
  /** Y rotation so the occupant faces the stage. */
  facing: number;
  tier: number;
  row: number;
};

/** Total rows across all decks, useful for colour ramps. */
export const TOTAL_ROWS = ARENA.tiers.reduce((n, t) => n + t.rows, 0);

/** Geometry of one seating row, resolved from the tier table. */
export function rowMetrics(tierIndex: number, row: number) {
  const t = ARENA.tiers[tierIndex];
  return { r: t.r0 + row * t.tread, y: t.y0 + row * t.rise };
}

/**
 * Ground height under a world point, computed rather than raycast.
 *
 * The walk controller needs this every frame. Raycasting the bowl to get it is
 * a non-starter: that mesh is one non-indexed buffer of ~150k triangles, and
 * testing it per frame drops the frame rate far enough that movement visibly
 * crawls. The bowl is a known analytic shape, so just evaluate it.
 */
export function groundHeightAt(x: number, z: number): number {
  const r = Math.hypot(x / ARENA.ellipse.a, z / ARENA.ellipse.b);

  // Pitch, plaza, street — all flat.
  if (r <= ARENA.floorR) return 0;

  for (const tier of ARENA.tiers) {
    const rEnd = tier.r0 + tier.rows * tier.tread;
    if (r >= tier.r0 && r <= rEnd) {
      const row = Math.floor((r - tier.r0) / tier.tread);
      return tier.y0 + row * tier.rise;
    }
    // Concourse gap between this deck and the next.
    if (r > rEnd && r < tier.r0 + tier.rows * tier.tread + 8) {
      return tier.y0 + tier.rows * tier.rise;
    }
  }
  return 0;
}
