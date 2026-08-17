import * as THREE from 'three';
import { createGlowTexture, mergeParts } from './materials';
import type { SharedUniforms } from '@/engine/core/uniforms';

export type FixtureGroup =
  | 'backTruss'
  | 'frontTruss'
  | 'sideL'
  | 'sideR'
  | 'floor'
  | 'houseA'
  | 'houseB'
  | 'houseC';

export const FIXTURE_GROUPS: FixtureGroup[] = [
  'backTruss',
  'frontTruss',
  'sideL',
  'sideR',
  'floor',
  'houseA',
  'houseB',
  'houseC',
];

/**
 * One moving head. The director writes `targetAim` / `targetColor` /
 * `targetIntensity`; the rig slews toward them. That split is what makes the
 * show feel like hardware — real heads take a beat to travel, and a light
 * "snapping" instantly to a new position is the tell of a fake light show.
 */
export type Fixture = {
  group: FixtureGroup;
  /** Index within its group, for patterns that need a position along the truss. */
  slot: number;
  /** 0..1 across the group, precomputed for gradient patterns. */
  t: number;
  position: THREE.Vector3;
  aim: THREE.Vector3;
  targetAim: THREE.Vector3;
  color: THREE.Color;
  targetColor: THREE.Color;
  intensity: number;
  targetIntensity: number;
  /** Cone radius at full throw. */
  spread: number;
  length: number;
  /** Aim slew, in units/second of travel at the aim point. */
  slew: number;
};

const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Volumetric beam field
// ---------------------------------------------------------------------------

const BEAM_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aIntensity;

varying vec2 vUv;
varying vec3 vColor;
varying float vIntensity;
varying vec3 vNormalW;
varying vec3 vViewW;

void main() {
  vUv = uv;
  vColor = aColor;
  vIntensity = aIntensity;

  mat4 im = instanceMatrix;

  // The instance matrix is rotation * non-uniform scale (spread, spread, length)
  // with no shear, so the correct normal transform is R * S^-1 — recoverable by
  // reading the column lengths back off the matrix.
  vec3 sc = vec3(length(im[0].xyz), length(im[1].xyz), length(im[2].xyz));
  mat3 rot = mat3(im[0].xyz / sc.x, im[1].xyz / sc.y, im[2].xyz / sc.z);
  vec3 n = normal / max(sc, vec3(1e-4));

  vec4 world = modelMatrix * im * vec4(position, 1.0);
  vNormalW = normalize(mat3(modelMatrix) * (rot * n));
  vViewW = cameraPosition - world.xyz;

  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Fake volumetrics, done honestly.
 *
 * A hollow cone is drawn additively from both sides. Brightness follows
 * |dot(normal, view)|, which peaks along the cone's projected centre-line and
 * falls to zero at its silhouette — the same profile you'd get from integrating
 * haze along the view ray, for none of the cost. No raymarching, no depth
 * prepass, one draw call for every beam in the venue.
 */
const BEAM_FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform float uHaze;
uniform float uAxialFade;
uniform float uCoreBoost;
uniform float uGain;

varying vec2 vUv;
varying vec3 vColor;
varying float vIntensity;
varying vec3 vNormalW;
varying vec3 vViewW;

void main() {
  if (vIntensity <= 0.003) discard;

  float along = 1.0 - vUv.y;                 // 0 at the lens, 1 at full throw

  float axial = pow(1.0 - along, uAxialFade);
  axial *= smoothstep(0.0, 0.035, along);    // soften the point at the lens

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(vViewW);
  float facing = abs(dot(N, V));
  float section = pow(facing, 1.8);

  // Lamp flicker. Barely perceptible individually, but across 70 fixtures it
  // stops the rig looking like it was rendered rather than switched on.
  float flick = 0.94 + 0.06 * sin(uTime * 41.0 + vColor.r * 21.0 + vColor.b * 13.0);

  float a = axial * section * vIntensity * uHaze * flick;
  if (a <= 0.002) discard;

  vec3 col = vColor * uGain;
  col += vColor * pow(facing, 8.0) * uCoreBoost;   // hot core down the axis

  gl_FragColor = vec4(col, a);
}
`;

class BeamField {
  mesh: THREE.InstancedMesh;
  private colorAttr: THREE.InstancedBufferAttribute;
  private intenAttr: THREE.InstancedBufferAttribute;
  private geo: THREE.ConeGeometry;
  private mat: THREE.ShaderMaterial;
  private m = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(
    u: SharedUniforms,
    count: number,
    opts: {
      radialSegments?: number;
      axialFade?: number;
      coreBoost?: number;
      gain?: number;
      renderOrder?: number;
    } = {},
  ) {
    this.geo = new THREE.ConeGeometry(1, 1, opts.radialSegments ?? 22, 1, true);
    this.geo.translate(0, -0.5, 0); // apex to the origin
    this.geo.rotateX(Math.PI / 2); // throw down -Z, matching lookAt convention

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: u.uTime,
        uHaze: u.uHaze,
        uAxialFade: { value: opts.axialFade ?? 1.35 },
        uCoreBoost: { value: opts.coreBoost ?? 0.5 },
        uGain: { value: opts.gain ?? 1.5 },
      },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });

    const colors = new Float32Array(count * 3);
    const inten = new Float32Array(count);
    this.colorAttr = new THREE.InstancedBufferAttribute(colors, 3);
    this.intenAttr = new THREE.InstancedBufferAttribute(inten, 1);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.intenAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aColor', this.colorAttr);
    this.geo.setAttribute('aIntensity', this.intenAttr);

    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 10;
  }

  set(
    i: number,
    pos: THREE.Vector3,
    aim: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    spread: number,
    length: number,
  ) {
    // Matrix4.lookAt(eye, target, up) puts -Z along (target - eye), which is
    // exactly how the cone geometry is oriented.
    this.rot.lookAt(pos, aim, UP);
    this.q.setFromRotationMatrix(this.rot);
    this.s.set(spread, spread, length);
    this.mesh.setMatrixAt(i, this.m.compose(pos, this.q, this.s));
    this.colorAttr.setXYZ(i, color.r, color.g, color.b);
    this.intenAttr.setX(i, intensity);
  }

  hide(i: number) {
    this.intenAttr.setX(i, 0);
  }

  commit() {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.intenAttr.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

function strut(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, 5, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize());
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
      q,
      new THREE.Vector3(1, 1, 1),
    ),
  );
  return g;
}

/** Square-section lattice truss between two points — 4 chords plus zig-zags. */
function latticeTruss(from: THREE.Vector3, to: THREE.Vector3, size = 0.85, bay = 2.6) {
  const parts: THREE.BufferGeometry[] = [];
  const axis = new THREE.Vector3().subVectors(to, from);
  const len = axis.length();
  const dir = axis.clone().normalize();
  // Build an orthonormal frame around the truss run.
  const side = new THREE.Vector3().crossVectors(dir, UP);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  side.normalize();
  const vert = new THREE.Vector3().crossVectors(side, dir).normalize();

  const h = size / 2;
  const corners = [
    side.clone().multiplyScalar(h).add(vert.clone().multiplyScalar(h)),
    side.clone().multiplyScalar(-h).add(vert.clone().multiplyScalar(h)),
    side.clone().multiplyScalar(-h).add(vert.clone().multiplyScalar(-h)),
    side.clone().multiplyScalar(h).add(vert.clone().multiplyScalar(-h)),
  ];

  for (const c of corners) {
    parts.push(strut(from.clone().add(c), to.clone().add(c), 0.075));
  }

  const bays = Math.max(1, Math.round(len / bay));
  for (let i = 0; i < bays; i++) {
    const a = from.clone().addScaledVector(dir, (i / bays) * len);
    const b = from.clone().addScaledVector(dir, ((i + 1) / bays) * len);
    for (let k = 0; k < 4; k++) {
      const c0 = corners[k];
      const c1 = corners[(k + 1) % 4];
      // Alternate the diagonal direction bay to bay for a proper Warren truss.
      const flip = i % 2 === 0;
      parts.push(strut(a.clone().add(c0), b.clone().add(flip ? c1 : c0.clone()), 0.05));
      parts.push(strut(a.clone().add(c1), b.clone().add(flip ? c1.clone() : c0), 0.05));
    }
  }
  return parts;
}

type TrussRun = { from: [number, number, number]; to: [number, number, number]; size?: number };

const TRUSS_RUNS: TrussRun[] = [
  // Stage rig
  { from: [-54, 26, -18], to: [-54, 26, 18], size: 1.0 }, // upstage / back truss
  { from: [-33, 21.5, -19], to: [-33, 21.5, 19], size: 1.0 }, // front truss
  { from: [-44, 24, -21], to: [-44, 24, 21], size: 0.8 }, // mid truss
  // Towers
  { from: [-44, 2.4, -21], to: [-44, 26, -21], size: 0.9 },
  { from: [-44, 2.4, 21], to: [-44, 26, 21], size: 0.9 },
  { from: [-56, 2.4, -18], to: [-56, 27, -18], size: 0.9 },
  { from: [-56, 2.4, 18], to: [-56, 27, 18], size: 0.9 },
  // Flown house rig over the floor
  { from: [-6, 34, -30], to: [-6, 34, 30], size: 0.9 },
  { from: [18, 34, -30], to: [18, 34, 30], size: 0.9 },
  { from: [42, 34, -30], to: [42, 34, 30], size: 0.9 },
];

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

export type Rig = {
  group: THREE.Group;
  fixtures: Fixture[];
  groups: Record<FixtureGroup, Fixture[]>;
  /** Laser projector origins. */
  laserOrigins: THREE.Vector3[];
  /** 0..1 — audience blinders on the front truss. */
  setBlinders(v: number): void;
  /** 0..1 — white strobe pods. */
  setStrobes(v: number): void;
  /**
   * Global multiplier on how much the beams read in air, 0..1. Driven by time
   * of day — a 2000W beam is invisible against a blue sky, and pretending
   * otherwise is the fastest way to make a daytime show look fake.
   */
  setBeamGain(g: number): void;
  /** Aim/colour/intensity slew plus GPU upload. Call once per frame. */
  update(dt: number): void;
  setLaser(i: number, aim: THREE.Vector3, color: THREE.Color, intensity: number): void;
  laserCount: number;
  dispose(): void;
};

function makeFixture(
  group: FixtureGroup,
  slot: number,
  count: number,
  position: THREE.Vector3,
  opts: { spread?: number; length?: number; slew?: number } = {},
): Fixture {
  const aim = position.clone().add(new THREE.Vector3(10, -6, 0));
  return {
    group,
    slot,
    t: count > 1 ? slot / (count - 1) : 0.5,
    position,
    aim,
    targetAim: aim.clone(),
    color: new THREE.Color(0x111111),
    targetColor: new THREE.Color(0x111111),
    intensity: 0,
    targetIntensity: 0,
    spread: opts.spread ?? 2.1,
    length: opts.length ?? 115,
    slew: opts.slew ?? 90,
  };
}

export function buildRig(u: SharedUniforms, opts: { beamSegments?: number } = {}): Rig {
  const group = new THREE.Group();
  group.name = 'rig';
  const fixtures: Fixture[] = [];
  const groups = Object.fromEntries(FIXTURE_GROUPS.map((g) => [g, [] as Fixture[]])) as Record<
    FixtureGroup,
    Fixture[]
  >;

  const line = (
    g: FixtureGroup,
    n: number,
    from: THREE.Vector3,
    to: THREE.Vector3,
    o?: { spread?: number; length?: number; slew?: number },
  ) => {
    for (let i = 0; i < n; i++) {
      const p = from.clone().lerp(to, n === 1 ? 0.5 : i / (n - 1));
      const f = makeFixture(g, i, n, p, o);
      fixtures.push(f);
      groups[g].push(f);
    }
  };

  // Back truss: the beam wall. Tight optics, long throw — these are the ones
  // that read from the far side of the bowl.
  line('backTruss', 12, new THREE.Vector3(-53.5, 25.2, -17), new THREE.Vector3(-53.5, 25.2, 17), {
    spread: 1.7,
    length: 150,
    slew: 120,
  });
  // Front truss: key light for the stage, plus audience sweeps.
  line('frontTruss', 12, new THREE.Vector3(-33, 20.6, -18), new THREE.Vector3(-33, 20.6, 18), {
    spread: 2.3,
    length: 120,
  });
  line('sideL', 6, new THREE.Vector3(-44, 6, -20.4), new THREE.Vector3(-44, 23.5, -20.4), {
    spread: 2.0,
    length: 110,
  });
  line('sideR', 6, new THREE.Vector3(-44, 6, 20.4), new THREE.Vector3(-44, 23.5, 20.4), {
    spread: 2.0,
    length: 110,
  });
  // Floor package upstage of the band: pure silhouette-maker.
  line('floor', 8, new THREE.Vector3(-52, 2.7, -14), new THREE.Vector3(-52, 2.7, 14), {
    spread: 1.9,
    length: 130,
    slew: 70,
  });
  // Flown house rig — beams directly over the crowd, which is what makes a
  // seat POV feel like being *inside* a show rather than watching one.
  line('houseA', 10, new THREE.Vector3(-6, 33.4, -28), new THREE.Vector3(-6, 33.4, 28), {
    spread: 2.6,
    length: 90,
  });
  line('houseB', 10, new THREE.Vector3(18, 33.4, -28), new THREE.Vector3(18, 33.4, 28), {
    spread: 2.6,
    length: 90,
  });
  line('houseC', 10, new THREE.Vector3(42, 33.4, -28), new THREE.Vector3(42, 33.4, 28), {
    spread: 2.6,
    length: 90,
  });

  // ---- trussing -------------------------------------------------------------
  const trussParts: THREE.BufferGeometry[] = [];
  for (const run of TRUSS_RUNS) {
    trussParts.push(
      ...latticeTruss(
        new THREE.Vector3(...run.from),
        new THREE.Vector3(...run.to),
        run.size ?? 0.85,
      ),
    );
  }
  // Hang cables for the flown rig.
  for (const x of [-6, 18, 42]) {
    for (const z of [-30, -10, 10, 30]) {
      trussParts.push(
        strut(new THREE.Vector3(x, 34, z), new THREE.Vector3(x, 61, z * 1.35), 0.045),
      );
    }
  }
  const trussGeo = mergeParts(trussParts);
  const trussMat = new THREE.MeshStandardMaterial({ color: 0x0f1118, roughness: 0.5, metalness: 0.8 });
  const trussMesh = new THREE.Mesh(trussGeo, trussMat);
  trussMesh.name = 'truss';
  group.add(trussMesh);

  // ---- fixture bodies -------------------------------------------------------
  const yoke = new THREE.BoxGeometry(0.42, 0.5, 0.34);
  const barrel = new THREE.CylinderGeometry(0.17, 0.21, 0.62, 10, 1, true);
  barrel.rotateX(Math.PI / 2);
  barrel.translate(0, 0, -0.36);
  const headGeo = mergeParts([yoke, barrel]);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x0a0b10, roughness: 0.42, metalness: 0.7 });
  const heads = new THREE.InstancedMesh(headGeo, headMat, fixtures.length);
  heads.frustumCulled = false;
  group.add(heads);

  // ---- beams ----------------------------------------------------------------
  const beams = new BeamField(u, fixtures.length, {
    radialSegments: opts.beamSegments ?? 22,
    axialFade: 1.3,
    coreBoost: 0.55,
    gain: 1.55,
  });
  group.add(beams.mesh);

  // ---- lens glows -----------------------------------------------------------
  const glowTex = createGlowTexture(96, 0.1);
  const glowGeo = new THREE.BufferGeometry();
  const glowPos = new Float32Array(fixtures.length * 3);
  const glowCol = new Float32Array(fixtures.length * 3);
  const glowSize = new Float32Array(fixtures.length);
  fixtures.forEach((f, i) => {
    glowPos[i * 3] = f.position.x;
    glowPos[i * 3 + 1] = f.position.y;
    glowPos[i * 3 + 2] = f.position.z;
  });
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPos, 3));
  const glowColAttr = new THREE.Float32BufferAttribute(glowCol, 3);
  const glowSizeAttr = new THREE.Float32BufferAttribute(glowSize, 1);
  glowColAttr.setUsage(THREE.DynamicDrawUsage);
  glowSizeAttr.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('aColor', glowColAttr);
  glowGeo.setAttribute('aSize', glowSizeAttr);

  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: glowTex } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      varying vec3 vColor;
      varying float vOn;
      void main() {
        vColor = aColor;
        vOn = step(0.004, aSize);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * 900.0 / max(0.001, -mv.z), 1.0, 90.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uTex;
      varying vec3 vColor;
      varying float vOn;
      void main() {
        if (vOn < 0.5) discard;
        float a = texture2D(uTex, gl_PointCoord).a;
        gl_FragColor = vec4(vColor * a * 3.0, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.frustumCulled = false;
  glows.renderOrder = 11;
  group.add(glows);

  // ---- audience blinders ----------------------------------------------------
  // Rows of warm PARs pointed straight at the crowd. Firing these on a drop is
  // the single most physical-feeling moment a virtual show can produce.
  const blinderGeo = new THREE.PlaneGeometry(2.6, 1.5);
  blinderGeo.rotateY(Math.PI / 2); // face +X, toward the audience
  const blinderMat = new THREE.MeshBasicMaterial({ toneMapped: true, side: THREE.DoubleSide });
  const blinderCount = 16;
  const blinders = new THREE.InstancedMesh(blinderGeo, blinderMat, blinderCount);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (let i = 0; i < blinderCount; i++) {
      const col = i % 8;
      const rowY = i < 8 ? 19.2 : 22.4;
      p.set(-32.4, rowY, -16 + (col / 7) * 32);
      blinders.setMatrixAt(i, m.compose(p, q, s));
      blinders.setColorAt(i, new THREE.Color(0, 0, 0));
    }
    blinders.instanceMatrix.needsUpdate = true;
  }
  group.add(blinders);

  // ---- strobe pods ----------------------------------------------------------
  const strobeGeo = new THREE.PlaneGeometry(1.1, 0.7);
  strobeGeo.rotateY(Math.PI / 2);
  const strobeMat = new THREE.MeshBasicMaterial({ toneMapped: true, side: THREE.DoubleSide });
  const strobePositions: THREE.Vector3[] = [];
  for (let i = 0; i < 8; i++) strobePositions.push(new THREE.Vector3(-52.6, 25.6, -15 + (i / 7) * 30));
  for (let i = 0; i < 6; i++) strobePositions.push(new THREE.Vector3(-33.6, 23, -15 + (i / 5) * 30));
  const strobes = new THREE.InstancedMesh(strobeGeo, strobeMat, strobePositions.length);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    strobePositions.forEach((p, i) => {
      strobes.setMatrixAt(i, m.compose(p, q, s));
      strobes.setColorAt(i, new THREE.Color(0, 0, 0));
    });
    strobes.instanceMatrix.needsUpdate = true;
  }
  group.add(strobes);

  // ---- lasers ---------------------------------------------------------------
  // Hard, near-parallel cones: same shader, different optics.
  const laserOrigins = [
    new THREE.Vector3(-50, 13, -12),
    new THREE.Vector3(-50, 13, 12),
    new THREE.Vector3(-38, 24, 0),
  ];
  const laserPerProjector = 14;
  const laserCount = laserOrigins.length * laserPerProjector;
  const lasers = new BeamField(u, laserCount, {
    radialSegments: 8,
    axialFade: 0.25,
    coreBoost: 1.6,
    gain: 2.4,
    renderOrder: 12,
  });
  group.add(lasers.mesh);
  const laserSpread = 0.09;

  // ---- real lights ----------------------------------------------------------
  // A handful of actual SpotLights so beams genuinely land on the stage and the
  // crowd. Shadowless and decay-free: this is stylised light, not a lighting
  // simulation, and 8 shadow maps would cost more than the whole rig.
  const boundSpots: Array<{ light: THREE.SpotLight; fixture: Fixture; gain: number }> = [];
  const spotSources: Array<[FixtureGroup, number, number]> = [
    ['frontTruss', 2, 5],
    ['frontTruss', 9, 5],
    ['backTruss', 5, 4],
    ['houseA', 4, 3.2],
    ['houseB', 5, 3.2],
    ['houseC', 4, 3.2],
    ['floor', 3, 3],
    ['sideR', 3, 2.6],
  ];
  for (const [g, idx, gain] of spotSources) {
    const fixture = groups[g][idx];
    if (!fixture) continue;
    const light = new THREE.SpotLight(0xffffff, 0, 260, 0.22, 0.7, 0);
    light.position.copy(fixture.position);
    light.castShadow = false;
    group.add(light);
    group.add(light.target);
    boundSpots.push({ light, fixture, gain });
  }

  const headM = new THREE.Matrix4();
  const headRot = new THREE.Matrix4();
  const headQ = new THREE.Quaternion();
  const headS = new THREE.Vector3(1, 1, 1);
  const aimDelta = new THREE.Vector3();
  let blinderLevel = 0;
  let strobeLevel = 0;
  let beamGain = 1;
  const blinderColor = new THREE.Color();
  const strobeColor = new THREE.Color();

  return {
    group,
    fixtures,
    groups,
    laserOrigins,
    laserCount,

    setBeamGain(g: number) {
      beamGain = THREE.MathUtils.clamp(g, 0, 1);
    },

    setBlinders(v: number) {
      blinderLevel = v;
    },
    setStrobes(v: number) {
      strobeLevel = v;
    },

    setLaser(i: number, aim: THREE.Vector3, color: THREE.Color, intensity: number) {
      if (i < 0 || i >= laserCount) return;
      const origin = laserOrigins[Math.floor(i / laserPerProjector)];
      const scaled = intensity * beamGain;
      if (scaled <= 0.001) lasers.hide(i);
      else lasers.set(i, origin, aim, color, scaled, laserSpread, 170);
    },

    update(dt: number) {
      for (let i = 0; i < fixtures.length; i++) {
        const f = fixtures[i];

        // Aim slew, capped in world units/sec so long throws take real time.
        aimDelta.subVectors(f.targetAim, f.aim);
        const dist = aimDelta.length();
        if (dist > 1e-4) {
          const step = Math.min(dist, f.slew * dt);
          f.aim.addScaledVector(aimDelta.divideScalar(dist), step);
        }

        // Colour crossfades; intensity snaps up and releases slowly, like a
        // lamp with a shutter in front of it.
        f.color.lerp(f.targetColor, Math.min(1, dt * 9));
        const rising = f.targetIntensity > f.intensity;
        f.intensity += (f.targetIntensity - f.intensity) * Math.min(1, dt * (rising ? 34 : 11));

        // The fixture's logical intensity stays intact — the lamp is still on,
        // and its SpotLight still lights the stage. Only the visible shaft of
        // light in the air is scaled by daylight.
        beams.set(i, f.position, f.aim, f.color, f.intensity * beamGain, f.spread, f.length);

        headRot.lookAt(f.position, f.aim, UP);
        headQ.setFromRotationMatrix(headRot);
        heads.setMatrixAt(i, headM.compose(f.position, headQ, headS));

        const g = Math.min(1, f.intensity * 1.15);
        glowColAttr.setXYZ(i, f.color.r * g, f.color.g * g, f.color.b * g);
        // Lens glow survives daylight better than the beam does, but not fully.
        glowSizeAttr.setX(i, g * 0.12 * (0.3 + 0.7 * beamGain));
      }

      beams.commit();
      lasers.commit();
      heads.instanceMatrix.needsUpdate = true;
      glowColAttr.needsUpdate = true;
      glowSizeAttr.needsUpdate = true;

      for (const { light, fixture, gain } of boundSpots) {
        light.color.copy(fixture.color);
        light.intensity = fixture.intensity * gain;
        light.target.position.copy(fixture.aim);
        light.angle = Math.min(0.5, Math.atan2(fixture.spread * 1.6, fixture.length) + 0.06);
      }

      blinderColor.setRGB(blinderLevel * 1.5, blinderLevel * 1.16, blinderLevel * 0.72);
      for (let i = 0; i < blinderCount; i++) blinders.setColorAt(i, blinderColor);
      if (blinders.instanceColor) blinders.instanceColor.needsUpdate = true;

      strobeColor.setRGB(strobeLevel * 2.2, strobeLevel * 2.2, strobeLevel * 2.4);
      for (let i = 0; i < strobePositions.length; i++) strobes.setColorAt(i, strobeColor);
      if (strobes.instanceColor) strobes.instanceColor.needsUpdate = true;
    },

    dispose() {
      trussGeo.dispose();
      trussMat.dispose();
      headGeo.dispose();
      headMat.dispose();
      heads.dispose();
      beams.dispose();
      lasers.dispose();
      glowGeo.dispose();
      glowMat.dispose();
      glowTex.dispose();
      blinderGeo.dispose();
      blinderMat.dispose();
      blinders.dispose();
      strobeGeo.dispose();
      strobeMat.dispose();
      strobes.dispose();
    },
  };
}
