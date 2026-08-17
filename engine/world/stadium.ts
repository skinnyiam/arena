import * as THREE from 'three';
import { ARENA, crowdDensityAt } from './layout';
import { createEmitMaterial, createScreenMaterial, SCREEN } from './materials';
import type { SharedUniforms } from '@/engine/core/uniforms';

export type Stadium = {
  group: THREE.Group;
  /** Surfaces the "teleport to any point" raycast is allowed to land on. */
  pickTargets: THREE.Mesh[];
  dispose(): void;
};

/**
 * Accumulates the venue shell as raw triangles with vertex colours.
 *
 * A stadium bowl is thousands of concentric steps. Instancing them would still
 * cost thousands of matrices and give us no per-row colour control, so instead
 * everything lands in one non-indexed buffer: a single draw call, flat-shaded
 * (which is what `computeVertexNormals` gives non-indexed geometry — and
 * exactly right for hard concrete steps), with colour authored per quad.
 */
class ShellBuilder {
  private pos: number[] = [];
  private col: number[] = [];

  constructor(private seg: number) {}

  /**
   * One ring of quads between (r0,y0) on the inner edge and (r1,y1) on the
   * outer. r0===r1 gives a vertical wall; y0===y1 gives a flat deck.
   */
  ring(
    r0: number,
    y0: number,
    r1: number,
    y1: number,
    colorAt: (theta: number, i: number) => THREE.Color,
  ) {
    const { a, b } = ARENA.ellipse;
    const seg = this.seg;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2;
      const t1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(t0);
      const s0 = Math.sin(t0);
      const c1 = Math.cos(t1);
      const s1 = Math.sin(t1);

      const c = colorAt((t0 + t1) * 0.5, i);
      this.tri(
        r0 * a * c0, y0, r0 * b * s0,
        r0 * a * c1, y0, r0 * b * s1,
        r1 * a * c1, y1, r1 * b * s1,
        c,
      );
      this.tri(
        r0 * a * c0, y0, r0 * b * s0,
        r1 * a * c1, y1, r1 * b * s1,
        r1 * a * c0, y1, r1 * b * s0,
        c,
      );
    }
  }

  private tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    color: THREE.Color,
  ) {
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let k = 0; k < 3; k++) this.col.push(color.r, color.g, color.b);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }

  get triangleCount() {
    return this.pos.length / 9;
  }
}

/** Open elliptical cylinder — used for every ribbon board and facia strip. */
function ellipseCylinder(r: number, height: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, seg, 1, true);
  g.scale(r * ARENA.ellipse.a, height, r * ARENA.ellipse.b);
  return g;
}

export function buildStadium(u: SharedUniforms, opts: { segments?: number } = {}): Stadium {
  const seg = opts.segments ?? ARENA.segments;
  const group = new THREE.Group();
  group.name = 'stadium';

  const disposables: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // ---- palette for the shell -------------------------------------------------
  const seatA = new THREE.Color('#26325c');
  const seatB = new THREE.Color('#324076');
  const stairCol = new THREE.Color('#4d5878');
  const riserCol = new THREE.Color('#0c101c');
  const concrete = new THREE.Color('#171b26');
  const curtain = new THREE.Color('#07090f');
  const tmp = new THREE.Color();

  const aisleEvery = Math.max(6, Math.round(seg / 14));

  const bowl = new ShellBuilder(seg);

  /** Seat rows fade toward black where a real venue would kill the section. */
  const seatColor = (row: number) => (theta: number, i: number) => {
    const base = row % 7 === 3 ? seatB : seatA;
    const isAisle = i % aisleEvery === 0;
    tmp.copy(isAisle ? stairCol : base);
    return tmp.lerp(curtain, 1 - crowdDensityAt(theta));
  };
  const flat = (c: THREE.Color) => () => c;
  const fadedFlat = (c: THREE.Color) => (theta: number) =>
    tmp.copy(c).lerp(curtain, (1 - crowdDensityAt(theta)) * 0.7);

  // ---- pitch-level wall in front of the first row ---------------------------
  bowl.ring(ARENA.floorR + 2, 0, ARENA.floorR + 2, ARENA.tiers[0].y0, flat(concrete));

  // ---- seating decks --------------------------------------------------------
  ARENA.tiers.forEach((tier, ti) => {
    let r = tier.r0;
    let y = tier.y0;
    for (let row = 0; row < tier.rows; row++) {
      bowl.ring(r, y, r + tier.tread, y, seatColor(row)); // tread
      bowl.ring(r + tier.tread, y, r + tier.tread, y + tier.rise, fadedFlat(riserCol)); // riser
      r += tier.tread;
      y += tier.rise;
    }

    const next = ARENA.tiers[ti + 1];
    if (next) {
      // Facia wall up to the next deck, then the concourse slab across the gap.
      bowl.ring(r, y, r, next.y0, flat(concrete));
      bowl.ring(r, next.y0, next.r0, next.y0, flat(concrete));
    } else {
      // Top parapet, then out to the roof line.
      bowl.ring(r, y, r, y + 3.2, flat(concrete));
      bowl.ring(r, y + 3.2, ARENA.roof.rInner, y + 3.6, flat(concrete));
    }
  });

  const bowlGeo = track(bowl.build());
  const bowlMat = track(
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  const bowlMesh = new THREE.Mesh(bowlGeo, bowlMat);
  bowlMesh.name = 'bowl';
  group.add(bowlMesh);

  // ---- general-admission floor ---------------------------------------------
  const floorGeo = track(new THREE.CircleGeometry(1, seg));
  floorGeo.rotateX(-Math.PI / 2);
  floorGeo.scale(ARENA.floorR * ARENA.ellipse.a, 1, ARENA.floorR * ARENA.ellipse.b);
  const floorMesh = new THREE.Mesh(
    floorGeo,
    track(new THREE.MeshLambertMaterial({ color: 0x0a0c13 })),
  );
  floorMesh.name = 'floor';
  group.add(floorMesh);

  // ---- ribbon LED boards ----------------------------------------------------
  // Two rings: one on the pitch-level wall, one on the mid-bowl facia. These do
  // an enormous amount of aesthetic work — they wrap the whole bowl in moving
  // light, which is what sells "stadium" over "model of a stadium".
  const ribbonMat = track(
    createScreenMaterial(u, {
      mode: SCREEN.MARQUEE,
      repeat: [520, 6],
      brightness: 0.5,
      doubleSided: true,
    }),
  );

  const lowerRibbon = new THREE.Mesh(
    track(ellipseCylinder(ARENA.floorR + 1.9, 1.25, seg)),
    ribbonMat,
  );
  lowerRibbon.position.y = ARENA.tiers[0].y0 - 0.8;
  group.add(lowerRibbon);

  const tier0Top = {
    r: ARENA.tiers[0].r0 + ARENA.tiers[0].rows * ARENA.tiers[0].tread,
    y: ARENA.tiers[0].y0 + ARENA.tiers[0].rows * ARENA.tiers[0].rise,
  };
  const midRibbon = new THREE.Mesh(track(ellipseCylinder(tier0Top.r - 0.05, 1.5, seg)), ribbonMat);
  midRibbon.position.y = tier0Top.y + 1.1;
  group.add(midRibbon);

  // ---- executive suites ----------------------------------------------------
  // A ring of warm lit windows set into the club-level facia, between the lower
  // and upper decks. Cheap detail, huge payoff: it gives the dark bowl depth and
  // a sense of human occupancy. They have to sit *in* the wall — floating in
  // front of it, they read as glowing boxes hanging in mid-air.
  const tier1 = ARENA.tiers[1];
  const tier1Top = {
    r: tier1.r0 + tier1.rows * tier1.tread,
    y: tier1.y0 + tier1.rows * tier1.rise,
  };
  const suiteCount = Math.floor(seg / 2);
  const suiteGeo = track(new THREE.BoxGeometry(2.4, 1.3, 0.5));
  const suiteMat = track(new THREE.MeshBasicMaterial({ toneMapped: true }));
  const suites = new THREE.InstancedMesh(suiteGeo, suiteMat, suiteCount);
  suites.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const warm = new THREE.Color();
  // Recessed a touch behind the facia plane, mid-way up the gap to the upper deck.
  const suiteR = tier1Top.r - 0.35;
  const suiteY = tier1Top.y + (ARENA.tiers[2].y0 - tier1Top.y) / 2;
  for (let i = 0; i < suiteCount; i++) {
    const theta = (i / suiteCount) * Math.PI * 2;
    pos.set(
      suiteR * ARENA.ellipse.a * Math.cos(theta),
      suiteY,
      suiteR * ARENA.ellipse.b * Math.sin(theta),
    );
    q.setFromAxisAngle(up, -theta);
    suites.setMatrixAt(i, m4.compose(pos, q, scale));
    // A handful are dark, and the lit ones vary — nothing reads as fake faster
    // than a perfectly uniform row of windows.
    const lit = crowdDensityAt(theta) > 0.35 && (i * 2654435761) % 11 > 2;
    const k = lit ? 0.1 + ((i * 7919) % 100) / 900 : 0.012;
    warm.setHSL(0.09, 0.5, 0.5).multiplyScalar(k);
    suites.setColorAt(i, warm);
  }
  suites.instanceMatrix.needsUpdate = true;
  if (suites.instanceColor) suites.instanceColor.needsUpdate = true;
  group.add(suites);

  // ---- roof canopy ---------------------------------------------------------
  const shell = new ShellBuilder(seg);
  const roofCol = new THREE.Color('#121520');
  shell.ring(ARENA.roof.rInner, ARENA.roof.y, ARENA.roof.rOuter, ARENA.roof.y - 5, flat(roofCol));
  // Inner skin, dropping only as far as the exterior podium deck — everything
  // outside this radius belongs to the exterior module now.
  shell.ring(ARENA.roof.rOuter, ARENA.roof.y - 5, ARENA.roof.rOuter, 10, flat(new THREE.Color('#3a3752')));
  const shellMesh = new THREE.Mesh(
    track(shell.build()),
    track(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })),
  );
  shellMesh.name = 'shell';
  group.add(shellMesh);

  // Emissive strip under the roof lip: a cool horizon line above the top deck.
  const roofStrip = new THREE.Mesh(
    track(ellipseCylinder(ARENA.roof.rInner + 1, 0.6, seg)),
    track(createEmitMaterial('#2a3f6b', 0.5)),
  );
  roofStrip.position.y = ARENA.roof.y - 0.7;
  group.add(roofStrip);

  // Radial roof trusses, instanced.
  const trussCount = 44;
  const trussGeo = track(
    new THREE.BoxGeometry(ARENA.roof.rOuter - ARENA.roof.rInner + 6, 1.1, 1.1),
  );
  const trussMesh = new THREE.InstancedMesh(trussGeo, track(new THREE.MeshStandardMaterial({ color: 0x1a1e29, roughness: 0.6, metalness: 0.6 })), trussCount);
  const midR = (ARENA.roof.rInner + ARENA.roof.rOuter) / 2 - 2;
  for (let i = 0; i < trussCount; i++) {
    const theta = (i / trussCount) * Math.PI * 2;
    pos.set(
      midR * ARENA.ellipse.a * Math.cos(theta),
      ARENA.roof.y - 1.4,
      midR * ARENA.ellipse.b * Math.sin(theta),
    );
    // Point the long axis outward along the local radial direction.
    const radial = Math.atan2(
      ARENA.ellipse.b * Math.sin(theta),
      ARENA.ellipse.a * Math.cos(theta),
    );
    q.setFromAxisAngle(up, -radial);
    trussMesh.setMatrixAt(i, m4.compose(pos, q, scale));
  }
  trussMesh.instanceMatrix.needsUpdate = true;
  group.add(trussMesh);

  return {
    group,
    pickTargets: [bowlMesh, floorMesh],
    dispose() {
      disposables.forEach((d) => d.dispose());
      suites.dispose();
      trussMesh.dispose();
    },
  };
}
