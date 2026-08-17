import * as THREE from 'three';

/**
 * Distance-based volume — the music growing as you approach the building.
 *
 * True 3D panning isn't available: the track plays in a cross-origin YouTube
 * iframe, so its samples never reach the Web Audio graph and there is no node
 * to attach a PannerNode to. What we *can* do is drive the player's own volume
 * from the listener's distance, which reproduces the part that actually
 * matters — the swell as you walk in — even though it can't reproduce
 * direction or the low-pass muffling you'd hear through a wall.
 *
 * The curve is deliberately not linear. Loudness falls off roughly with the
 * inverse of distance, and a linear ramp reads as an obvious fade rather than
 * as getting closer to a PA.
 */

export type ProximityConfig = {
  /** Inside this radius you're at the show: full volume. */
  inner: number;
  /** Beyond this, only a distant thump. */
  outer: number;
  /** Floor level at maximum distance, 0..1. */
  minVolume: number;
  /** Curve shape; >1 keeps it quiet until you're close. */
  falloff: number;
};

export const DEFAULT_PROXIMITY: ProximityConfig = {
  // Inner sits just inside the bowl so stepping through a gate is a real jump
  // in level, not a gradual creep. The floor is deliberately low: from the far
  // end of the street it should be a thump you can barely hear.
  inner: 150,
  outer: 540,
  minVolume: 0.03,
  falloff: 2.3,
};

/** Elliptical distance from the venue centre, matching the bowl's footprint. */
export function venueDistance(p: THREE.Vector3Like): number {
  return Math.hypot(p.x / 1.3, p.z);
}

export function proximityVolume(
  distance: number,
  cfg: ProximityConfig = DEFAULT_PROXIMITY,
): number {
  const t = THREE.MathUtils.clamp(
    (cfg.outer - distance) / Math.max(1e-6, cfg.outer - cfg.inner),
    0,
    1,
  );
  return cfg.minVolume + (1 - cfg.minVolume) * Math.pow(t, cfg.falloff);
}

/**
 * Smooths the volume so a fast camera cut doesn't slam the level, and reports
 * only meaningful changes — the YouTube player's `setVolume` is a cross-frame
 * call and isn't worth making 60 times a second.
 */
export class ProximityMixer {
  private current = 1;
  private lastReported = -1;

  constructor(
    private cfg: ProximityConfig = DEFAULT_PROXIMITY,
    /** Minimum change worth pushing to the player. */
    private epsilon = 0.02,
  ) {}

  setConfig(cfg: Partial<ProximityConfig>) {
    this.cfg = { ...this.cfg, ...cfg };
  }

  /** @returns the new volume when it has moved enough to be worth applying. */
  update(dt: number, listener: THREE.Vector3Like): number | null {
    const target = proximityVolume(venueDistance(listener), this.cfg);
    this.current += (target - this.current) * Math.min(1, dt * 3.2);
    if (Math.abs(this.current - this.lastReported) < this.epsilon) return null;
    this.lastReported = this.current;
    return this.current;
  }

  get value() {
    return this.current;
  }

  reset(v = 1) {
    this.current = v;
    this.lastReported = -1;
  }
}
