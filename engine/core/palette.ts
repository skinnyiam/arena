import * as THREE from 'three';

/**
 * Lighting palettes. Real LDs work from a small set of gels per song section —
 * these are picked to stay saturated after bloom and tone mapping, which is
 * where naive pastel choices turn to grey mush.
 */
export type PaletteName = keyof typeof PALETTES;

export const PALETTES = {
  neon: ['#ff2d95', '#22d3ee', '#7c3aed', '#f9fafb', '#00ffa3'],
  sunset: ['#ff5f1f', '#ffb703', '#ff2d6f', '#ffd7a8', '#c1121f'],
  ice: ['#7dd3fc', '#a5b4fc', '#e0f2fe', '#38bdf8', '#c4b5fd'],
  acid: ['#c6ff00', '#00e5ff', '#ff00e5', '#fffb00', '#00ff85'],
  blood: ['#ff1744', '#ff8a00', '#ffffff', '#b3001b', '#ff5252'],
  royal: ['#4c1d95', '#2563eb', '#f0abfc', '#ffffff', '#06b6d4'],
} as const;

export class Palette {
  name: PaletteName = 'neon';
  colors: THREE.Color[] = [];

  constructor(name: PaletteName = 'neon') {
    this.set(name);
  }

  set(name: PaletteName) {
    this.name = name;
    this.colors = PALETTES[name].map((hex) => new THREE.Color(hex));
  }

  /** Wrapping lookup so pattern code can index freely. */
  at(i: number): THREE.Color {
    const n = this.colors.length;
    return this.colors[((i % n) + n) % n];
  }

  /** Continuous ramp through the palette, for gradients across a truss. */
  ramp(t: number, out: THREE.Color): THREE.Color {
    const n = this.colors.length;
    const x = ((t % 1) + 1) % 1;
    const f = x * n;
    const i = Math.floor(f);
    return out.copy(this.at(i)).lerp(this.at(i + 1), f - i);
  }
}
