import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export type Quality = 'low' | 'medium' | 'high';

export const QUALITY_PRESETS: Record<
  Quality,
  {
    crowd: number;
    segments: number;
    bloom: boolean;
    /** Sun shadow maps — only meaningful while the sun is above the horizon. */
    shadows: boolean;
    pixelRatio: number;
    beamSegments: number;
    confetti: number;
    sparks: number;
  }
> = {
  low: { crowd: 9000, segments: 104, bloom: false, shadows: false, pixelRatio: 1, beamSegments: 10, confetti: 500, sparks: 700 },
  medium: { crowd: 24000, segments: 140, bloom: true, shadows: true, pixelRatio: 1.35, beamSegments: 16, confetti: 1000, sparks: 1300 },
  high: { crowd: 44000, segments: 168, bloom: true, shadows: true, pixelRatio: 2, beamSegments: 24, confetti: 1600, sparks: 2000 },
};

/**
 * Final grade. Runs after bloom and before tone mapping, so it works on linear
 * HDR values: a subtle lens vignette, chromatic aberration that only shows at
 * the edges, film grain to break up the huge flat gradients a dark scene has,
 * and a strobe flash the show director drives.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFlash: { value: 0 },
    uVignette: { value: 0.7 },
    uGrain: { value: 0.015 },
    uAberration: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uFlash;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    varying vec2 vUv;

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // Lateral chromatic aberration, scaled by distance from centre.
      vec2 off = d * uAberration * r2 * 0.03;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      float vig = smoothstep(0.95, 0.15, r2 * 2.1);
      col *= mix(1.0, vig, uVignette);

      col += uFlash;

      float n = fract(sin(dot(vUv * vec2(1024.0, 731.0) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export type Pipeline = {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  setFlash(v: number): void;
  setTime(t: number): void;
  setBloom(on: boolean): void;
  /** Tone-mapping exposure — the time-of-day system drives this. */
  setExposure(v: number): void;
  /** Bloom is a night-time effect; daylight needs far less of it. */
  setBloomStrength(v: number): void;
  setPixelRatioCap(cap: number): void;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
};

export function createPipeline(
  canvas: HTMLCanvasElement,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: Quality,
): Pipeline {
  const preset = QUALITY_PRESETS[quality];

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // the composer does its own AA-ish work; MSAA here is wasted
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  // The sun is the only shadow caster, and only while it is up; the daylight
  // system toggles `castShadow` on it rather than rebuilding the pipeline.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = true;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Threshold sits low: in a night venue almost everything bright *is* a light
  // source, and that is exactly what should bloom.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.7,
    0.7,
    0.3,
  );
  bloom.enabled = preset.bloom;
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  composer.addPass(new OutputPass());

  let cap = preset.pixelRatio;
  let bloomAllowed = preset.bloom;

  return {
    renderer,
    composer,

    setFlash(v) {
      grade.uniforms.uFlash.value = v;
    },
    setTime(t) {
      grade.uniforms.uTime.value = t;
    },
    setBloom(on) {
      bloomAllowed = on;
      bloom.enabled = on;
    },
    setExposure(v) {
      renderer.toneMappingExposure = v;
    },
    setBloomStrength(v) {
      if (bloomAllowed) bloom.strength = v;
    },
    setPixelRatioCap(next) {
      cap = next;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
    },
    resize(width, height) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
      renderer.setSize(width, height, false);
      composer.setSize(width, height);
    },
    render() {
      composer.render();
    },
    dispose() {
      composer.dispose();
      bloom.dispose();
      renderer.dispose();
    },
  };
}
