import * as THREE from 'three';
import { ARENA, crowdDensityAt, STAGE_FRONT } from './layout';
import { createGlowTexture, mergeParts } from './materials';
import type { SharedUniforms } from '@/engine/core/uniforms';

export type Crowd = {
  group: THREE.Group;
  /** Total generated attendees — the venue at capacity. */
  count: number;
  /** How full the bowl currently is, 0..1. */
  occupancy: number;
  /** Flat xyz triples, one per attendee — used to pick LOD takeover targets. */
  positions: Float32Array;
  /** Y rotation per attendee. */
  facings: Float32Array;
  /** 1 if standing on the floor, 0 if seated. */
  standing: Uint8Array;
  /** Fill or empty the venue. Cheap: it just moves the instanced draw count. */
  setOccupancy(v: number): void;
  /**
   * Hide these instances so a detailed character can stand in their place.
   * Anything previously hidden and not in the new set is restored.
   */
  setHidden(next: Set<number>): void;
  dispose(): void;
};

/** Deterministic RNG so the same venue rebuilds identically across reloads. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A person, at the crudest fidelity that still reads as a person from 60m. */
function personGeometry(): THREE.BufferGeometry {
  const torso = new THREE.BoxGeometry(0.44, 0.66, 0.26);
  torso.translate(0, 0.33, 0);
  const head = new THREE.IcosahedronGeometry(0.135, 0);
  head.translate(0, 0.81, 0);
  return mergeParts([torso, head]);
}

type Slot = { x: number; y: number; z: number; facing: number; standing: boolean };

/**
 * Fills the venue. Seated punters go on the deck treads with the tier maths;
 * the standing floor crowd is rejection-sampled inside the pitch ellipse,
 * denser toward the barrier, with the stage and thrust carved out.
 */
function sampleSlots(count: number, rng: () => number): Slot[] {
  const slots: Slot[] = [];
  const floorShare = 0.24;
  const floorTarget = Math.floor(count * floorShare);

  const aR = ARENA.floorR * ARENA.ellipse.a;
  const bR = ARENA.floorR * ARENA.ellipse.b;
  const stageBack = ARENA.stage.cx - ARENA.stage.depth / 2;

  // --- standing floor ---
  let guard = 0;
  while (slots.length < floorTarget && guard++ < floorTarget * 60) {
    const x = (rng() * 2 - 1) * aR;
    const z = (rng() * 2 - 1) * bR;
    if ((x / aR) ** 2 + (z / bR) ** 2 > 0.97) continue;
    if (x < STAGE_FRONT + 1.6) continue; // behind the barrier / under the stage
    if (x < ARENA.stage.thrustTo && Math.abs(z) < ARENA.stage.thrustWidth / 2 + 1.2) continue;

    // Pit is packed, the back of the floor is not.
    const depth = (x - STAGE_FRONT) / (aR - STAGE_FRONT);
    if (rng() > 1 - 0.6 * depth) continue;

    slots.push({
      x,
      y: 0,
      z,
      facing: Math.atan2(stageBack - x, -z),
      standing: true,
    });
  }

  // --- seated decks ---
  const weights = ARENA.tiers.map((t) => t.rows * (t.r0 + (t.rows * t.tread) / 2));
  const total = weights.reduce((a, b) => a + b, 0);
  guard = 0;
  while (slots.length < count && guard++ < count * 60) {
    let pick = rng() * total;
    let ti = 0;
    while (ti < weights.length - 1 && pick > weights[ti]) {
      pick -= weights[ti];
      ti++;
    }
    const tier = ARENA.tiers[ti];
    const row = Math.floor(rng() * tier.rows);
    const theta = rng() * Math.PI * 2;
    if (rng() > crowdDensityAt(theta)) continue; // curtained sections stay empty

    const r = tier.r0 + row * tier.tread + tier.tread * (0.35 + rng() * 0.3);
    const y = tier.y0 + row * tier.rise + 0.34;
    const x = r * ARENA.ellipse.a * Math.cos(theta);
    const z = r * ARENA.ellipse.b * Math.sin(theta);
    slots.push({ x, y, z, facing: Math.atan2(stageBack - x, -z), standing: false });
  }

  return slots;
}

export function buildCrowd(u: SharedUniforms, opts: { count: number }): Crowd {
  const group = new THREE.Group();
  group.name = 'crowd';
  const rng = mulberry32(0xc0ffee);
  const slots = sampleSlots(opts.count, rng);

  // Shuffle before laying instances out. Occupancy is then just a draw-count
  // truncation, and the first N instances are a uniform random sample of the
  // venue — so the bowl fills in scattered and plausible instead of filling
  // the floor first and the upper deck last.
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }

  const n = slots.length;

  // ---- bodies ---------------------------------------------------------------
  const geo = personGeometry();
  const phase = new Float32Array(n);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    phase[i] = rng();
    seed[i] = rng();
  }
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));

  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });

  // Beat-synced motion lives in the vertex shader: 30,000 CPU-side matrix
  // updates per frame would cost more than the rest of the venue combined.
  // The bob happens in instance-local space, before instanceMatrix is applied,
  // so it stays vertical no matter which way the punter faces.
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBeat = u.uBeat;
    shader.uniforms.uEnergy = u.uEnergy;
    shader.uniforms.uPulse = u.uPulse;
    shader.vertexShader =
      `attribute float aPhase;
       attribute float aSeed;
       uniform float uBeat;
       uniform float uEnergy;
       uniform float uPulse;
      ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
      #include <begin_vertex>
      float ph = aPhase * 6.28318;
      // Half the crowd is on the beat, half is lazily off it.
      float sync = step(0.35, aSeed);
      float wave = sin(uBeat * 6.28318 + ph * mix(1.0, 0.15, sync));
      float jump = max(0.0, wave);
      transformed.y += jump * (0.06 + 0.30 * uEnergy) * (0.55 + 0.45 * aSeed);
      transformed.x += sin(uBeat * 3.14159 + ph) * 0.07 * uEnergy;
      transformed.z += cos(uBeat * 3.14159 + ph * 1.7) * 0.04 * uEnergy;
      `,
    );
  };

  const bodies = new THREE.InstancedMesh(geo, mat, n);
  // Dynamic because the LOD system swaps individual instances out for detailed
  // characters as you get close to them.
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.frustumCulled = false; // instance bounds span the whole venue

  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();

  // Kept so hidden instances can be restored, and so the LOD system knows
  // where every attendee is without walking the matrix buffer.
  const slotPositions = new Float32Array(n * 3);
  const slotFacings = new Float32Array(n);
  const slotStanding = new Uint8Array(n);
  const baseMatrix = new Float32Array(n * 16);

  for (let i = 0; i < n; i++) {
    const slot = slots[i];
    slotPositions[i * 3] = slot.x;
    slotPositions[i * 3 + 1] = slot.y;
    slotPositions[i * 3 + 2] = slot.z;
    slotFacings[i] = slot.facing;
    slotStanding[i] = slot.standing ? 1 : 0;
    p.set(slot.x, slot.y, slot.z);
    q.setFromAxisAngle(up, slot.facing);
    const h = slot.standing ? 0.95 + rng() * 0.14 : 0.74 + rng() * 0.1;
    s.set(0.9 + rng() * 0.2, h, 0.9 + rng() * 0.2);
    bodies.setMatrixAt(i, m4.compose(p, q, s));
    m4.toArray(baseMatrix, i * 16);

    // Mostly dark clothing with a scattering of light tops. Dark reads better:
    // the crowd should be a silhouette that beams paint, not a field of colour.
    const bright = rng();
    if (bright > 0.94) col.setHSL(rng(), 0.15, 0.62);
    else if (bright > 0.78) col.setHSL(rng(), 0.35, 0.3);
    else col.setHSL(0.6 + rng() * 0.1, 0.25, 0.07 + rng() * 0.1);
    bodies.setColorAt(i, col);
  }
  bodies.instanceMatrix.needsUpdate = true;
  if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
  group.add(bodies);

  // ---- phone torches + camera flashes ---------------------------------------
  // The single most evocative thing in a dark stadium. Threshold per point
  // against uPhones so the "phones up" wave rises and falls smoothly.
  const pts = new THREE.BufferGeometry();
  const pp = new Float32Array(n * 3);
  const prand = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const slot = slots[i];
    pp[i * 3] = slot.x + (rng() - 0.5) * 0.2;
    pp[i * 3 + 1] = slot.y + (slot.standing ? 1.55 : 1.15) + rng() * 0.35;
    pp[i * 3 + 2] = slot.z + (rng() - 0.5) * 0.2;
    prand[i] = rng();
  }
  pts.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
  pts.setAttribute('aRand', new THREE.Float32BufferAttribute(prand, 1));
  pts.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase.slice(), 1));

  const glow = createGlowTexture(64, 0.06);
  const phoneMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: u.uTime,
      uBeat: u.uBeat,
      uEnergy: u.uEnergy,
      uPhones: u.uPhones,
      uTex: { value: glow },
      uColor: { value: new THREE.Color('#ffe6bd') },
      uSize: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      attribute float aRand;
      attribute float aPhase;
      uniform float uTime;
      uniform float uBeat;
      uniform float uEnergy;
      uniform float uPhones;
      uniform float uSize;
      varying float vAlpha;

      void main() {
        float on = step(aRand, uPhones);
        float twinkle = 0.7 + 0.3 * sin(uTime * 3.1 + aPhase * 6.283);
        // Camera flashes fire from the punters who are NOT holding a torch up,
        // so the two effects never fight for the same pixel.
        float pop = pow(fract(uTime * 0.37 + aPhase * 11.0), 70.0) * step(0.93, aRand);
        vAlpha = max(on * twinkle, pop * 1.8);

        vec3 sway = vec3(sin(uBeat * 3.14159 + aPhase * 6.283) * 0.10 * uEnergy, 0.0, 0.0);
        vec4 mv = modelViewMatrix * vec4(position + sway, 1.0);
        gl_PointSize = clamp(uSize * 300.0 / max(0.001, -mv.z), 0.8, 26.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uTex;
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        if (vAlpha <= 0.012) discard;
        float a = texture2D(uTex, gl_PointCoord).a;
        gl_FragColor = vec4(uColor * a * vAlpha * 2.4, a * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const phones = new THREE.Points(pts, phoneMat);
  phones.frustumCulled = false;
  phones.renderOrder = 3;
  group.add(phones);

  const hidden = new Set<number>();
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const restore = new THREE.Matrix4();

  const api: Crowd = {
    group,
    count: n,
    occupancy: 1,
    positions: slotPositions,
    facings: slotFacings,
    standing: slotStanding,

    setHidden(next: Set<number>) {
      let dirty = false;
      for (const i of hidden) {
        if (!next.has(i)) {
          bodies.setMatrixAt(i, restore.fromArray(baseMatrix, i * 16));
          dirty = true;
        }
      }
      for (const i of next) {
        if (!hidden.has(i)) {
          bodies.setMatrixAt(i, zeroMatrix);
          dirty = true;
        }
      }
      if (dirty) bodies.instanceMatrix.needsUpdate = true;
      hidden.clear();
      for (const i of next) hidden.add(i);
    },

    setOccupancy(v: number) {
      const k = THREE.MathUtils.clamp(v, 0, 1);
      api.occupancy = k;
      const shown = Math.floor(n * k);
      bodies.count = shown;
      pts.setDrawRange(0, shown);
    },

    dispose() {
      geo.dispose();
      mat.dispose();
      bodies.dispose();
      pts.dispose();
      phoneMat.dispose();
      glow.dispose();
    },
  };

  return api;
}
