import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SharedUniforms } from '@/engine/core/uniforms';

/**
 * Merge parts into one geometry, disposing the sources.
 *
 * `mergeGeometries` refuses to mix indexed and non-indexed inputs, and three's
 * primitives disagree: Box/Cylinder/Capsule are indexed, Icosahedron and
 * friends are not. Flattening everything to non-indexed first makes any
 * combination safe, and costs nothing worth counting on geometry this small.
 */
export function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => p.toNonIndexed());
  const merged = mergeGeometries(flat, false);
  flat.forEach((f) => f.dispose());
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error('mergeParts: incompatible geometry attributes');
  return merged;
}

/**
 * Radial falloff sprite, generated rather than shipped. Used for fixture glows,
 * phone lights, sparks and atmospheric haze — anything that should read as
 * light rather than as a surface.
 */
export function createGlowTexture(size = 128, hardness = 0.18): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * hardness, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.42)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.09)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type ScreenMode = 0 | 1 | 2 | 3 | 4;
export const SCREEN = {
  PLASMA: 0 as const,
  BARS: 1 as const,
  SCAN: 2 as const,
  FLASH: 3 as const,
  MARQUEE: 4 as const,
};

const SCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * LED surface shader — video walls, side IMAG panels and the ribbon boards that
 * ring the bowl all run this. It draws unlit and can exceed 1.0 so the bloom
 * pass has something real to catch.
 */
const SCREEN_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uBeat;
uniform float uPulse;
uniform float uEnergy;
uniform vec3  uAccentA;
uniform vec3  uAccentB;
uniform float uMode;
uniform float uBrightness;
uniform vec2  uRepeat;

varying vec2 vUv;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

vec3 modePlasma(vec2 uv) {
  float t = uTime * 0.35 + uBeat * 0.22;
  float v = sin(uv.x * 7.0 + t) + sin(uv.y * 9.0 - t * 1.3) + sin((uv.x + uv.y) * 6.0 + t * 0.7);
  v = v / 3.0 * 0.5 + 0.5;
  return mix(uAccentA, uAccentB, v) * (0.22 + 0.55 * uEnergy);
}

vec3 modeBars(vec2 uv) {
  float cols = 28.0;
  float i = floor(uv.x * cols);
  float seed = hash11(i + 3.0);
  float h = 0.18 + 0.82 * abs(sin(i * 1.7 + uTime * 2.4 + seed * 6.283));
  h *= 0.35 + 0.65 * uEnergy;
  h = mix(h, min(1.0, h * 1.4), uPulse);
  float on = step(uv.y, h);
  float tip = smoothstep(h - 0.06, h, uv.y) * on;
  vec3 c = mix(uAccentA, uAccentB, uv.y);
  return (c * on + vec3(1.0) * tip * 0.7) * (0.55 + 0.9 * uEnergy);
}

vec3 modeScan(vec2 uv) {
  float k = fract(uv.y * 5.0 - uBeat * 0.5);
  float band = smoothstep(1.0, 0.0, abs(k - 0.5) * 2.4);
  vec3 c = mix(uAccentB, uAccentA, uv.x);
  return c * band * (0.5 + 1.1 * uEnergy);
}

vec3 modeFlash(vec2 uv) {
  float edge = smoothstep(0.0, 0.35, uv.y) * smoothstep(1.0, 0.65, uv.y);
  return vec3(1.0) * (0.25 + 1.5 * uPulse) * (0.5 + 0.5 * edge);
}

vec3 modeMarquee(vec2 uv) {
  float x = fract(uv.x * 6.0 - uTime * 0.24);
  float s = smoothstep(0.0, 0.12, x) * smoothstep(0.58, 0.42, x);
  vec3 c = mix(uAccentA, uAccentB, fract(uv.x * 3.0 - uTime * 0.09));
  return c * (0.18 + 0.9 * s) * (0.45 + 0.75 * uEnergy);
}

void main() {
  vec2 uv = vUv;
  int m = int(uMode + 0.5);

  vec3 col;
  if (m == 1)      col = modeBars(uv);
  else if (m == 2) col = modeScan(uv);
  else if (m == 3) col = modeFlash(uv);
  else if (m == 4) col = modeMarquee(uv);
  else             col = modePlasma(uv);

  // Physical LED pixels: round emitters on a dark carrier board.
  vec2 g = fract(uv * uRepeat) - 0.5;
  float pixel = smoothstep(0.5, 0.4, length(g));
  col *= mix(0.42, 1.0, pixel);

  // Slight vertical falloff keeps giant walls from reading as flat gradients.
  col *= 0.85 + 0.15 * uv.y;

  gl_FragColor = vec4(col * uBrightness, 1.0);
}
`;

export function createScreenMaterial(
  u: SharedUniforms,
  opts: { mode?: number; repeat?: [number, number]; brightness?: number; doubleSided?: boolean } = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      // Shared by reference — the director writes these once per frame.
      uTime: u.uTime,
      uBeat: u.uBeat,
      uPulse: u.uPulse,
      uEnergy: u.uEnergy,
      uAccentA: u.uAccentA,
      uAccentB: u.uAccentB,
      // Per-surface.
      uMode: { value: opts.mode ?? SCREEN.PLASMA },
      uBrightness: { value: opts.brightness ?? 1 },
      uRepeat: { value: new THREE.Vector2(...(opts.repeat ?? [90, 40])) },
    },
    vertexShader: SCREEN_VERT,
    fragmentShader: SCREEN_FRAG,
    side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    toneMapped: true,
  });
}

/** Dark, slightly shiny structural metal — trussing, towers, PA boxes. */
export function createMetalMaterial(color = 0x14161d, roughness = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.75 });
}

/** Unlit emissive block, for anything that should bloom without being lit. */
export function createEmitMaterial(color: THREE.ColorRepresentation, intensity = 1) {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color: c, toneMapped: true });
}
