import * as THREE from 'three';
import { inkOutline, makeFlat, makeToon } from '@/engine/core/toon';
import { mergeParts } from './materials';

/**
 * The outside of the building: podium, facade, entrance frontage, signage and
 * the plaza you arrive across.
 *
 * Everything here is authored for cel shading — flat toon materials, hard
 * silhouettes, and geometry chunky enough that an ink outline reads at
 * distance. Detail comes from repetition and signage, not from surface noise.
 *
 * The venue's ellipse is shared with the interior (a=1.3 on X, b=1.0 on Z), so
 * the shell wraps the bowl exactly. The stage sits at -X, which makes +X the
 * far side of the bowl and the natural place for the main entrance.
 */

const A = 1.3;
const B = 1.0;

export const EXT = {
  segments: 176,
  /** Concrete plinth the building sits on. */
  podium: { rIn: 146, rOut: 168, y: 10, gateY: 7.2 },
  /** Steel lattice band. */
  facade: { r: 161, yBase: 10, yTop: 50, bays: 76 },
  /** Fascia band capping the facade. */
  crown: { rIn: 152, rOut: 178, yBase: 50, yTop: 57 },
  // Stops short of the approach street, which owns the ground beyond.
  plaza: { rIn: 168, rOut: 232 },
  /** Angular centres of the GA entrances, radians around +X. */
  gates: [-0.203, -0.0677, 0.0677, 0.203],
  gateHalf: 0.046,
} as const;

const PALETTE = {
  concrete: '#8e8aa0',
  concreteDark: '#6d6a80',
  steel: '#b9c0d4',
  crown: '#a49fb6',
  plaza: '#9a93a6',
  plazaLine: '#7e7891',
  tunnel: '#2a2740',
  purple: '#7b3fd4',
  purpleDeep: '#4a1f8f',
  lampPost: '#3e3b52',
  lampGlow: '#ffd9a0',
  kiosk: '#4c3f6b',
  kioskRoof: '#3a3054',
  trunk: '#5a4436',
  leafA: '#3f7a52',
  leafB: '#2f5f42',
  barrier: '#c3c8d8',
} as const;

export function ellipsePoint(r: number, theta: number, y = 0, out = new THREE.Vector3()) {
  return out.set(r * A * Math.cos(theta), y, r * B * Math.sin(theta));
}

/** Outward-facing yaw at a bearing, accounting for the ellipse's squash. */
function outwardYaw(theta: number): number {
  return Math.atan2(B * Math.sin(theta), A * Math.cos(theta));
}

// ---------------------------------------------------------------------------
// Generated textures
// ---------------------------------------------------------------------------

type SignOpts = {
  w?: number;
  h?: number;
  bg?: string;
  bg2?: string;
  fg?: string;
  weight?: number;
  padding?: number;
  vertical?: boolean;
  border?: string;
};

/** Lit signage panel: text drawn to a canvas, used unlit so it reads as LED. */
export function signTexture(lines: string[], opts: SignOpts = {}): THREE.CanvasTexture {
  const w = opts.w ?? 1024;
  const h = opts.h ?? 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;

  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, opts.bg ?? '#7b3fd4');
  g.addColorStop(1, opts.bg2 ?? '#4a1f8f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = Math.max(3, h * 0.035);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  }

  const pad = opts.padding ?? h * 0.16;
  const rows = lines.length;
  const rowH = (h - pad * 2) / rows;
  // Fit the widest line, so long text shrinks instead of overflowing.
  let size = rowH * 0.86;
  ctx.font = `${opts.weight ?? 800} ${size}px ui-sans-serif, "Helvetica Neue", Arial, sans-serif`;
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const maxW = w - pad * 2;
  if (widest > maxW) size *= maxW / widest;

  ctx.font = `${opts.weight ?? 800} ${size}px ui-sans-serif, "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.fg ?? '#ffffff';
  ctx.shadowColor = 'rgba(255,255,255,0.55)';
  ctx.shadowBlur = size * 0.22;
  lines.forEach((line, i) => {
    ctx.fillText(line, w / 2, pad + rowH * (i + 0.5));
  });

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Paving slabs, as flat tone plus joint lines. */
function pavingTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = PALETTE.plaza;
  ctx.fillRect(0, 0, s, s);

  ctx.strokeStyle = PALETTE.plazaLine;
  ctx.lineWidth = 3;
  const cells = 4;
  for (let i = 0; i <= cells; i++) {
    const p = (i / cells) * s;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(s, p);
    ctx.stroke();
  }
  // A few darker slabs so the grid isn't mechanically uniform.
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(Math.random() * cells) * (s / cells);
    const y = Math.floor(Math.random() * cells) * (s / cells);
    ctx.fillRect(x + 2, y + 2, s / cells - 4, s / cells - 4);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  return tex;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function box(
  w: number,
  h: number,
  d: number,
  pos: THREE.Vector3Like,
  rotY = 0,
  rotZ = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Matrix4().makeRotationY(rotY);
  if (rotZ) m.multiply(new THREE.Matrix4().makeRotationZ(rotZ));
  m.setPosition(pos.x, pos.y, pos.z);
  g.applyMatrix4(m);
  return g;
}

function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 5): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.normalize(),
  );
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
      q,
      new THREE.Vector3(1, 1, 1),
    ),
  );
  return g;
}

/**
 * A band of quads around the ellipse, optionally skipping bearings — which is
 * how the gate openings get punched through the podium wall.
 */
class Band {
  private pos: number[] = [];
  private norm: number[] = [];
  private uv: number[] = [];

  constructor(private seg: number) {}

  add(
    r0: number,
    y0: number,
    r1: number,
    y1: number,
    skip?: (theta: number) => boolean,
    uvScale = 1,
  ) {
    for (let i = 0; i < this.seg; i++) {
      const t0 = (i / this.seg) * Math.PI * 2;
      const t1 = ((i + 1) / this.seg) * Math.PI * 2;
      if (skip && skip((t0 + t1) * 0.5)) continue;

      const c0 = Math.cos(t0);
      const s0 = Math.sin(t0);
      const c1 = Math.cos(t1);
      const s1 = Math.sin(t1);

      const p00 = [r0 * A * c0, y0, r0 * B * s0];
      const p01 = [r0 * A * c1, y0, r0 * B * s1];
      const p11 = [r1 * A * c1, y1, r1 * B * s1];
      const p10 = [r1 * A * c0, y1, r1 * B * s0];

      const u0 = (i / this.seg) * uvScale;
      const u1 = ((i + 1) / this.seg) * uvScale;

      this.quad(p00, p01, p11, p10, u0, u1);
    }
    return this;
  }

  private quad(
    a: number[],
    b: number[],
    c: number[],
    d: number[],
    u0: number,
    u1: number,
  ) {
    const n = this.faceNormal(a, b, c);
    const push = (p: number[], u: number, v: number) => {
      this.pos.push(p[0], p[1], p[2]);
      this.norm.push(n[0], n[1], n[2]);
      this.uv.push(u, v);
    };
    push(a, u0, 0);
    push(b, u1, 0);
    push(c, u1, 1);
    push(a, u0, 0);
    push(c, u1, 1);
    push(d, u0, 1);
  }

  private faceNormal(a: number[], b: number[], c: number[]) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
  }
}

const inGate = (theta: number) => {
  // Normalise to [-PI, PI] so bearings either side of +X compare correctly.
  let t = theta;
  while (t > Math.PI) t -= Math.PI * 2;
  while (t < -Math.PI) t += Math.PI * 2;
  return EXT.gates.some((g) => Math.abs(t - g) < EXT.gateHalf);
};

// ---------------------------------------------------------------------------

export type Exterior = {
  group: THREE.Group;
  /** Ground the walk controller and arrival camera stand on. */
  walkTargets: THREE.Mesh[];
  /** Marquee copy — swap when the headliner changes. */
  setMarquee(lines: string[]): void;
  update(dt: number, night: number): void;
  dispose(): void;
};

export function buildExterior(opts: { segments?: number } = {}): Exterior {
  const seg = opts.segments ?? EXT.segments;
  const group = new THREE.Group();
  group.name = 'exterior';

  const trash: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(x: T) => {
    trash.push(x);
    return x;
  };

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, ink = 1.2, name = '') => {
    const mesh = new THREE.Mesh(keep(geo), mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (ink > 0) inkOutline(mesh, ink);
    return mesh;
  };

  // ---- materials -----------------------------------------------------------
  const concreteMat = keep(makeToon({ color: PALETTE.concrete, steps: 3 }));
  const concreteDarkMat = keep(makeToon({ color: PALETTE.concreteDark, steps: 3 }));
  const steelMat = keep(makeToon({ color: PALETTE.steel, steps: 3, shadowFloor: 0.42 }));
  const crownMat = keep(makeToon({ color: PALETTE.crown, steps: 3 }));
  const tunnelMat = keep(makeToon({ color: PALETTE.tunnel, steps: 2, shadowFloor: 0.5 }));
  const barrierMat = keep(makeToon({ color: PALETTE.barrier, steps: 3, shadowFloor: 0.45 }));
  const postMat = keep(makeToon({ color: PALETTE.lampPost, steps: 3 }));
  const kioskMat = keep(makeToon({ color: PALETTE.kiosk, steps: 3 }));
  const kioskRoofMat = keep(makeToon({ color: PALETTE.kioskRoof, steps: 3 }));
  const trunkMat = keep(makeToon({ color: PALETTE.trunk, steps: 3 }));
  const leafAMat = keep(makeToon({ color: PALETTE.leafA, steps: 3 }));
  const leafBMat = keep(makeToon({ color: PALETTE.leafB, steps: 3 }));

  // ---- plaza ---------------------------------------------------------------
  const paving = keep(pavingTexture());
  const plazaMat = keep(makeToon({ color: '#ffffff', steps: 3, shadowFloor: 0.55 }));
  plazaMat.map = paving;

  // Built as an elliptical band rather than a RingGeometry so its inner edge
  // meets the podium exactly instead of leaving a crescent gap.
  const plazaBand = new Band(seg);
  plazaBand.add(EXT.plaza.rIn, 0, EXT.plaza.rOut, 0, undefined, seg);
  const plazaMesh = new THREE.Mesh(keep(plazaBand.build()), plazaMat);
  plazaMesh.name = 'plaza';
  plazaMesh.receiveShadow = true;
  group.add(plazaMesh);

  // Ground beyond the plaza, so the horizon isn't a hard edge into the sky.
  const groundMat = keep(makeToon({ color: '#57614f', steps: 2, shadowFloor: 0.6 }));
  const groundGeo = keep(new THREE.CircleGeometry(1150, 64));
  groundGeo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.position.y = -0.35;
  ground.receiveShadow = true;
  group.add(ground);

  // ---- podium --------------------------------------------------------------
  {
    const band = new Band(seg);
    // Lower wall, punched through at the gates.
    band.add(EXT.podium.rOut, 0, EXT.podium.rOut, EXT.podium.gateY, inGate);
    // Lintel course above the openings, continuous all the way round.
    band.add(EXT.podium.rOut, EXT.podium.gateY, EXT.podium.rOut, EXT.podium.y);
    // Top deck and inner face.
    band.add(EXT.podium.rOut, EXT.podium.y, EXT.podium.rIn, EXT.podium.y);
    band.add(EXT.podium.rIn, EXT.podium.y, EXT.podium.rIn, 0, inGate);
    add(band.build(), concreteMat, 1.4, 'podium');
  }

  // Kerb line at the foot of the podium — a small step that catches the sun and
  // stops the building meeting the ground in a single flat seam.
  {
    const band = new Band(seg);
    band.add(EXT.podium.rOut + 1.6, 0.45, EXT.podium.rOut, 0.45);
    band.add(EXT.podium.rOut + 1.6, 0, EXT.podium.rOut + 1.6, 0.45);
    add(band.build(), concreteDarkMat, 0.9, 'kerb');
  }

  // ---- gate tunnels --------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const g of EXT.gates) {
      // Side reveals, built as thin radial slabs either side of the opening.
      for (const sign of [-1, 1]) {
        const th = g + sign * EXT.gateHalf;
        const yaw = outwardYaw(th);
        const pIn = ellipsePoint(EXT.podium.rIn, th, EXT.podium.gateY / 2);
        const pOut = ellipsePoint(EXT.podium.rOut, th, EXT.podium.gateY / 2);
        const mid = new THREE.Vector3().addVectors(pIn, pOut).multiplyScalar(0.5);
        const depth = pIn.distanceTo(pOut);
        parts.push(box(depth, EXT.podium.gateY, 0.9, mid, yaw));
      }
      // Dark recess at the back of the opening.
      const backTh = g;
      const back = ellipsePoint(EXT.podium.rIn - 1.2, backTh, EXT.podium.gateY / 2);
      parts.push(box(1.2, EXT.podium.gateY, EXT.gateHalf * EXT.podium.rIn * 2.1, back, outwardYaw(backTh)));
    }
    add(mergeParts(parts), tunnelMat, 0.9, 'gate-reveals');
  }

  // GA ENTRY headers, one above each opening.
  const gaTex = keep(signTexture(['GA ENTRY'], { w: 768, h: 192, border: 'rgba(255,255,255,0.85)' }));
  const gaMat = keep(makeFlat('#ffffff', 1.15));
  gaMat.map = gaTex;
  for (const g of EXT.gates) {
    const p = ellipsePoint(EXT.podium.rOut + 0.35, g, EXT.podium.gateY + 1.45);
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(13, 3.1)), gaMat);
    sign.position.copy(p);
    sign.rotation.y = outwardYaw(g) + Math.PI / 2;
    group.add(sign);
  }

  // Turnstile posts inside each opening.
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const g of EXT.gates) {
      const lanes = 5;
      for (let i = 0; i <= lanes; i++) {
        const th = g - EXT.gateHalf + (i / lanes) * EXT.gateHalf * 2;
        const p = ellipsePoint(EXT.podium.rOut - 1.4, th, 0.6);
        parts.push(box(1.1, 1.2, 0.5, p, outwardYaw(th)));
      }
    }
    add(mergeParts(parts), postMat, 0.8, 'turnstiles');
  }

  // ---- facade lattice ------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    const { r, yBase, yTop, bays } = EXT.facade;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    // Horizontal chords.
    for (const y of [yBase, yBase + (yTop - yBase) * 0.5, yTop]) {
      const band = new Band(seg);
      band.add(r, y, r, y + 0.7);
      band.add(r, y + 0.7, r - 0.8, y + 0.7);
      parts.push(band.build());
    }

    for (let i = 0; i < bays; i++) {
      const t0 = (i / bays) * Math.PI * 2;
      const t1 = ((i + 1) / bays) * Math.PI * 2;

      // Vertical mullion.
      ellipsePoint(r, t0, yBase, a);
      ellipsePoint(r, t0, yTop, b);
      parts.push(strut(a.clone(), b.clone(), 0.42));

      // Crossed diagonals — the signature of a modern stadium wrap.
      ellipsePoint(r, t0, yBase, a);
      ellipsePoint(r, t1, yTop, b);
      parts.push(strut(a.clone(), b.clone(), 0.3));
      ellipsePoint(r, t0, yTop, a);
      ellipsePoint(r, t1, yBase, b);
      parts.push(strut(a.clone(), b.clone(), 0.3));
    }
    add(mergeParts(parts), steelMat, 0.9, 'facade');
  }

  // Warm perimeter lights threaded through the lattice.
  const facadeLampMat = keep(makeFlat('#ffe6b8', 1.0));
  {
    const count = 96;
    const geo = keep(new THREE.SphereGeometry(0.42, 8, 6));
    const lamps = new THREE.InstancedMesh(geo, facadeLampMat, count * 2);
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let n = 0;
    for (let row = 0; row < 2; row++) {
      const y = EXT.facade.yBase + 3 + row * (EXT.facade.yTop - EXT.facade.yBase - 8);
      for (let i = 0; i < count; i++) {
        ellipsePoint(EXT.facade.r + 0.6, (i / count) * Math.PI * 2, y, p);
        lamps.setMatrixAt(n++, m4.identity().setPosition(p));
      }
    }
    lamps.instanceMatrix.needsUpdate = true;
    group.add(lamps);
  }

  // ---- crown ---------------------------------------------------------------
  {
    const band = new Band(seg);
    band.add(EXT.crown.rIn, EXT.crown.yBase, EXT.crown.rOut, EXT.crown.yBase + 2.5);
    band.add(EXT.crown.rOut, EXT.crown.yBase + 2.5, EXT.crown.rOut, EXT.crown.yTop);
    band.add(EXT.crown.rOut, EXT.crown.yTop, EXT.crown.rIn, EXT.crown.yTop);
    add(band.build(), crownMat, 1.4, 'crown');
  }

  // ---- marquee -------------------------------------------------------------
  const marqueeMat = keep(makeFlat('#ffffff', 1.25));
  let marqueeTex = keep(signTexture(['LIVE IN CONCERT'], { w: 1536, h: 320 }));
  marqueeMat.map = marqueeTex;

  add(
    box(2.2, 17, 88, new THREE.Vector3(EXT.crown.rOut * A - 3, EXT.crown.yTop + 5, 0)),
    concreteDarkMat,
    1.5,
    'marquee-frame',
  );
  {
    const screen = new THREE.Mesh(keep(new THREE.PlaneGeometry(82, 14)), marqueeMat);
    screen.position.set(EXT.crown.rOut * A - 1.7, EXT.crown.yTop + 5, 0);
    screen.rotation.y = Math.PI / 2;
    group.add(screen);
  }

  // Vertical LED pylons flanking the entrance.
  const pylonTex = keep(
    signTexture(['LIVE', 'MUSIC', 'LIVE', 'LIFE'], { w: 512, h: 1024, padding: 60 }),
  );
  const pylonMat = keep(makeFlat('#ffffff', 1.15));
  pylonMat.map = pylonTex;
  for (const z of [-74, 74]) {
    const x = EXT.podium.rOut * A - 14;
    add(box(2.4, 34, 15, new THREE.Vector3(x - 1.4, 30, z)), concreteDarkMat, 1.3, 'pylon');
    const face = new THREE.Mesh(keep(new THREE.PlaneGeometry(13, 31)), pylonMat);
    face.position.set(x, 30, z);
    face.rotation.y = Math.PI / 2;
    group.add(face);
  }

  // ---- queue barriers ------------------------------------------------------
  {
    const parts: THREE.BufferGeometry[] = [];
    const p = new THREE.Vector3();
    for (const g of EXT.gates) {
      // Lanes running out from the gate toward the plaza.
      for (const side of [-1, 1]) {
        const th = g + side * (EXT.gateHalf + 0.012);
        for (let i = 0; i < 7; i++) {
          const r = EXT.podium.rOut + 4 + i * 6;
          ellipsePoint(r, th, 0.62, p);
          const yaw = outwardYaw(th);
          parts.push(box(5.4, 0.16, 0.16, p, yaw + Math.PI / 2));
          parts.push(box(0.18, 1.25, 0.18, { x: p.x, y: 0.62, z: p.z }, yaw));
        }
      }
    }
    add(mergeParts(parts), barrierMat, 0.7, 'barriers');
  }

  // ---- street lamps --------------------------------------------------------
  const lampGlowMat = keep(makeFlat(PALETTE.lampGlow, 1.0));
  const lampHeads: THREE.Object3D[] = [];
  {
    const parts: THREE.BufferGeometry[] = [];
    const heads: THREE.Vector3[] = [];
    const rows = [-1, 1];
    for (const side of rows) {
      for (let i = 0; i < 6; i++) {
        const th = side * (0.30 + i * 0.052);
        const r = EXT.podium.rOut + 26 + (i % 2) * 4;
        const base = ellipsePoint(r, th, 0);
        const yaw = outwardYaw(th);
        parts.push(box(0.7, 11, 0.7, { x: base.x, y: 5.5, z: base.z }, yaw));
        // Curved arm, faked with two short segments.
        parts.push(box(3.2, 0.45, 0.45, { x: base.x - 1.4 * Math.cos(yaw), y: 11, z: base.z - 1.4 * Math.sin(yaw) }, yaw));
        const head = new THREE.Vector3(
          base.x - 3.0 * Math.cos(yaw),
          10.6,
          base.z - 3.0 * Math.sin(yaw),
        );
        parts.push(box(2.4, 0.7, 1.3, head, yaw));
        heads.push(head);
      }
    }
    add(mergeParts(parts), postMat, 0.9, 'lamps');

    const glowGeo = keep(new THREE.SphereGeometry(0.85, 10, 8));
    const glows = new THREE.InstancedMesh(glowGeo, lampGlowMat, heads.length);
    const m4 = new THREE.Matrix4();
    heads.forEach((h, i) => {
      m4.identity().setPosition(h.x, h.y - 0.5, h.z);
      glows.setMatrixAt(i, m4);
    });
    glows.instanceMatrix.needsUpdate = true;
    group.add(glows);
    lampHeads.push(glows);
  }

  // ---- kiosks --------------------------------------------------------------
  const kioskSigns: THREE.Mesh[] = [];
  const buildKiosk = (theta: number, r: number, label: string, tint: string) => {
    const base = ellipsePoint(r, theta, 0);
    const yaw = outwardYaw(theta) + Math.PI; // face back toward the stadium
    const parts: THREE.BufferGeometry[] = [];
    parts.push(box(9, 4.6, 14, { x: base.x, y: 2.3, z: base.z }, yaw));
    // Counter shelf on the plaza side.
    parts.push(
      box(1.6, 0.35, 12, { x: base.x + 5 * Math.cos(yaw), y: 2.6, z: base.z + 5 * Math.sin(yaw) }, yaw),
    );
    add(mergeParts(parts), kioskMat, 1.2, `kiosk-${label}`);

    const roof = box(11.5, 0.7, 16, { x: base.x, y: 5.0, z: base.z }, yaw);
    add(roof, kioskRoofMat, 1.2, `kiosk-roof-${label}`);

    const tex = keep(signTexture([label], { w: 768, h: 192, bg: tint, bg2: '#2a1650' }));
    const mat = keep(makeFlat('#ffffff', 1.1));
    mat.map = tex;
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(9.5, 2.4)), mat);
    sign.position.set(
      base.x + 4.6 * Math.cos(yaw),
      4.0,
      base.z + 4.6 * Math.sin(yaw),
    );
    sign.rotation.y = -yaw + Math.PI / 2;
    group.add(sign);
    kioskSigns.push(sign);

    // Warm interior spill so the kiosk reads as open and staffed after dark.
    const glowMat = keep(makeFlat('#ffd9a0', 0.9));
    const glow = new THREE.Mesh(keep(new THREE.PlaneGeometry(7.5, 2.6)), glowMat);
    glow.position.set(
      base.x + 4.3 * Math.cos(yaw),
      2.0,
      base.z + 4.3 * Math.sin(yaw),
    );
    glow.rotation.y = -yaw + Math.PI / 2;
    group.add(glow);
    kioskSigns.push(glow);
  };
  buildKiosk(-0.46, EXT.podium.rOut + 34, 'MERCH', '#7b3fd4');
  buildKiosk(0.46, EXT.podium.rOut + 34, 'FOOD & DRINKS', '#c2410c');

  // ---- A-frame board -------------------------------------------------------
  {
    const p = ellipsePoint(EXT.podium.rOut + 58, 0.30, 0);
    const yaw = outwardYaw(0.30) + Math.PI;
    const tex = keep(
      signTexture(['TONIGHT', 'IS GONNA BE', 'EPIC!'], {
        w: 640,
        h: 512,
        bg: '#7b3fd4',
        bg2: '#4a1f8f',
        border: 'rgba(255,255,255,0.9)',
      }),
    );
    const mat = keep(makeFlat('#ffffff', 1.05));
    mat.map = tex;
    for (const lean of [-0.18, 0.18]) {
      const boardGeo = new THREE.PlaneGeometry(3.4, 4.2);
      const board = new THREE.Mesh(keep(boardGeo), mat);
      board.position.set(p.x, 2.1, p.z);
      board.rotation.set(0, -yaw + Math.PI / 2, lean);
      group.add(board);
    }
    add(box(3.6, 0.2, 2.2, { x: p.x, y: 0.1, z: p.z }, yaw), postMat, 0.7, 'aframe-foot');
  }

  // ---- planting ------------------------------------------------------------
  {
    const trunks: THREE.BufferGeometry[] = [];
    const canopyA: THREE.BufferGeometry[] = [];
    const canopyB: THREE.BufferGeometry[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < 34; i++) {
      const th = -1.25 + (i / 33) * 2.5;
      if (Math.abs(th) < 0.55) continue; // keep the entrance approach clear
      const r = EXT.plaza.rOut - 26 - ((i * 37) % 40);
      ellipsePoint(r, th, 0, p);
      const h = 7 + ((i * 13) % 5);
      const t = new THREE.CylinderGeometry(0.5, 0.75, h, 6);
      t.translate(p.x, h / 2, p.z);
      trunks.push(t);
      // Two overlapping blobs make a believable stylised canopy.
      const c1 = new THREE.IcosahedronGeometry(3.6 + ((i * 7) % 3) * 0.4, 1);
      c1.translate(p.x, h + 1.6, p.z);
      canopyA.push(c1);
      const c2 = new THREE.IcosahedronGeometry(2.7, 1);
      c2.translate(p.x + 1.9, h + 3.2, p.z - 1.4);
      canopyB.push(c2);
    }
    if (trunks.length) {
      add(mergeParts(trunks), trunkMat, 0.8, 'trunks');
      add(mergeParts(canopyA), leafAMat, 1.1, 'canopy-a');
      add(mergeParts(canopyB), leafBMat, 1.1, 'canopy-b');
    }
  }

  // ---- night response ------------------------------------------------------
  const nightLit: Array<{ mat: THREE.MeshBasicMaterial; base: THREE.Color; day: number }> = [
    { mat: facadeLampMat, base: facadeLampMat.color.clone(), day: 0.08 },
    { mat: lampGlowMat, base: lampGlowMat.color.clone(), day: 0.05 },
  ];

  return {
    group,
    walkTargets: [plazaMesh, ground],

    setMarquee(lines: string[]) {
      const next = signTexture(lines, { w: 1536, h: 320 });
      marqueeMat.map = next;
      marqueeMat.needsUpdate = true;
      marqueeTex.dispose();
      marqueeTex = next;
    },

    update(_dt: number, night: number) {
      // Street and facade lamps only burn after dark, like the real thing.
      for (const l of nightLit) {
        const k = l.day + (1 - l.day) * night;
        l.mat.color.copy(l.base).multiplyScalar(k);
      }
    },

    dispose() {
      trash.forEach((t) => t.dispose());
      marqueeTex.dispose();
    },
  };
}
