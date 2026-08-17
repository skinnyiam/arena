import * as THREE from 'three';

/**
 * One bag of uniforms shared by every material in the venue. The show director
 * writes it once per frame; the crowd, LED walls, beams, haze and sky all read
 * from the same objects, so the whole arena breathes on the same beat.
 */
export type SharedUniforms = {
  uTime: { value: number };
  /** Fractional beat count since the song's downbeat. */
  uBeat: { value: number };
  /** 1.0 on the beat, decaying to 0 before the next one. */
  uPulse: { value: number };
  /** 0..1 overall show intensity for the current section. */
  uEnergy: { value: number };
  /** 0..1 low-end level (mic analyser, or synthesised from the beat clock). */
  uBass: { value: number };
  /** Fraction of the crowd holding a lit phone up. */
  uPhones: { value: number };
  /** Atmospheric density — how hard the beams read. */
  uHaze: { value: number };
  /** LED wall program index. */
  uScreenMode: { value: number };
  /** 0 = deep night, 1 = full daylight. Set by the time-of-day system. */
  uDayness: { value: number };
  uAccentA: { value: THREE.Color };
  uAccentB: { value: THREE.Color };
};

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uBeat: { value: 0 },
    uPulse: { value: 0 },
    uEnergy: { value: 0.25 },
    uBass: { value: 0 },
    uPhones: { value: 0 },
    uHaze: { value: 0.85 },
    uScreenMode: { value: 0 },
    uDayness: { value: 0 },
    uAccentA: { value: new THREE.Color('#ff2d95') },
    uAccentB: { value: new THREE.Color('#22d3ee') },
  };
}
