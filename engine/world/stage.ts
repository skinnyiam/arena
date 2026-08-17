import * as THREE from 'three';
import { ARENA, STAGE_FRONT } from './layout';
import { createEmitMaterial, createScreenMaterial, mergeParts, SCREEN } from './materials';
import type { SharedUniforms } from '@/engine/core/uniforms';

export type Stage = {
  group: THREE.Group;
  /** Video wall + IMAG panels; the director picks the program. */
  setScreenMode(mode: number): void;
  /**
   * Screen output multiplier. Daytime shows live or die on the video walls, so
   * they're driven much harder when the sun is up.
   */
  setScreenBoost(k: number): void;
  /** Hide the placeholder capsule band once rigged performers are available. */
  setPerformersVisible(v: boolean): void;
  update(dt: number, beat: number, energy: number): void;
  dispose(): void;
};

type Performer = {
  root: THREE.Group;
  home: THREE.Vector3;
  phase: number;
  /** Lead vocal roams the thrust; everyone else stays put. */
  roams: boolean;
};

export function buildStage(u: SharedUniforms): Stage {
  const group = new THREE.Group();
  group.name = 'stage';
  const dispose: Array<{ dispose(): void }> = [];
  const track = <T extends { dispose(): void }>(x: T) => {
    dispose.push(x);
    return x;
  };

  const S = ARENA.stage;
  const deckMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0b0c11, roughness: 0.85, metalness: 0.1 }),
  );

  // ---- decking --------------------------------------------------------------
  const deckParts: THREE.BufferGeometry[] = [];

  const main = new THREE.BoxGeometry(S.depth, S.deckY, S.width);
  main.translate(S.cx, S.deckY / 2, 0);
  deckParts.push(main);

  const thrustLen = STAGE_FRONT - S.thrustTo;
  const thrust = new THREE.BoxGeometry(thrustLen, S.deckY - 0.35, S.thrustWidth);
  thrust.translate(STAGE_FRONT - thrustLen / 2, (S.deckY - 0.35) / 2, 0);
  deckParts.push(thrust);

  // B-stage at the tip of the thrust — gives the show a second focal point and
  // a reason for the flown rig to exist over the middle of the floor.
  const bStage = new THREE.CylinderGeometry(5.2, 5.6, S.deckY - 0.35, 36);
  bStage.translate(S.thrustTo, (S.deckY - 0.35) / 2, 0);
  deckParts.push(bStage);

  const riser = new THREE.BoxGeometry(7, 1.1, 9);
  riser.translate(S.cx - 6, S.deckY + 0.55, 0);
  deckParts.push(riser);

  const wings = [-1, 1].map((sign) => {
    const g = new THREE.BoxGeometry(9, S.deckY + 0.8, 7);
    g.translate(S.cx - 2, (S.deckY + 0.8) / 2, sign * (S.width / 2 + 3.2));
    return g;
  });
  deckParts.push(...wings);

  const deckGeo = track(mergeParts(deckParts));
  group.add(new THREE.Mesh(deckGeo, deckMat));

  // Stage-edge light strip: reads the geometry of the deck even in a blackout.
  const lipGeo = track(new THREE.BoxGeometry(0.3, 0.16, S.width));
  const lip = new THREE.Mesh(lipGeo, track(createEmitMaterial('#3aa7ff', 0.8)));
  lip.position.set(STAGE_FRONT + 0.1, S.deckY - 0.1, 0);
  group.add(lip);

  const thrustLipGeo = track(new THREE.BoxGeometry(thrustLen, 0.14, 0.24));
  [-1, 1].forEach((sign) => {
    const m = new THREE.Mesh(thrustLipGeo, track(createEmitMaterial('#3aa7ff', 1.2)));
    m.position.set(STAGE_FRONT - thrustLen / 2, S.deckY - 0.42, (sign * S.thrustWidth) / 2);
    group.add(m);
  });

  // ---- video walls ----------------------------------------------------------
  const mainScreenMat = track(
    createScreenMaterial(u, { mode: SCREEN.PLASMA, repeat: [170, 80], brightness: 0.8 }),
  );
  const imagMat = track(
    createScreenMaterial(u, { mode: SCREEN.PLASMA, repeat: [90, 56], brightness: 0.85 }),
  );

  const wallGeo = track(new THREE.PlaneGeometry(S.width + 2, 17));
  const wall = new THREE.Mesh(wallGeo, mainScreenMat);
  wall.rotation.y = Math.PI / 2; // face the audience (+X)
  wall.position.set(S.cx - S.depth / 2 - 0.4, 11.4, 0);
  group.add(wall);

  // Dark surround so the wall reads as a framed screen, not a floating rectangle.
  const surroundGeo = track(new THREE.PlaneGeometry(S.width + 8, 22));
  const surround = new THREE.Mesh(
    surroundGeo,
    track(new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.95 })),
  );
  surround.rotation.y = Math.PI / 2;
  surround.position.set(S.cx - S.depth / 2 - 0.9, 12, 0);
  group.add(surround);

  const imagGeo = track(new THREE.PlaneGeometry(13, 8));
  [-1, 1].forEach((sign) => {
    const m = new THREE.Mesh(imagGeo, imagMat);
    m.position.set(-48, 12.5, sign * 20.5);
    m.rotation.y = Math.PI / 2 + sign * 0.34;
    group.add(m);
  });

  // Upstage floor LED, washing light back up over the band.
  const floorLedGeo = track(new THREE.PlaneGeometry(S.width - 6, 8));
  floorLedGeo.rotateX(-Math.PI / 2);
  const floorLedMat = track(
    createScreenMaterial(u, { mode: SCREEN.SCAN, repeat: [80, 24], brightness: 0.7 }),
  );
  const floorLed = new THREE.Mesh(floorLedGeo, floorLedMat);
  floorLed.rotation.z = Math.PI / 2;
  floorLed.position.set(S.cx - 1, S.deckY + 0.02, 0);
  group.add(floorLed);

  // ---- PA ------------------------------------------------------------------
  const paMat = track(new THREE.MeshStandardMaterial({ color: 0x0d0e13, roughness: 0.6, metalness: 0.3 }));
  const paParts: THREE.BufferGeometry[] = [];
  [-1, 1].forEach((sign) => {
    // Flown line array: cabinets splay outward down the hang, as they do in life.
    for (let i = 0; i < 9; i++) {
      const box = new THREE.BoxGeometry(1.5, 0.95, 2.8);
      const y = 22.5 - i * 1.05;
      const tilt = -0.04 - i * 0.035;
      const m = new THREE.Matrix4()
        .makeRotationZ(tilt)
        .setPosition(-38.5, y, sign * 20.5);
      box.applyMatrix4(m);
      paParts.push(box);
    }
    // Sub stacks on the deck.
    for (let i = 0; i < 3; i++) {
      const box = new THREE.BoxGeometry(2.2, 1.2, 2.4);
      box.translate(-37, 0.6 + i * 1.22, sign * 16.5);
      paParts.push(box);
    }
  });
  const paGeo = track(mergeParts(paParts));
  group.add(new THREE.Mesh(paGeo, paMat));

  // ---- band ----------------------------------------------------------------
  // Deliberately abstract. Backlit silhouettes read as musicians; detailed
  // low-poly humans read as broken low-poly humans.
  const bodyMat = track(
    new THREE.MeshStandardMaterial({ color: 0x0e1016, roughness: 0.75, metalness: 0.15 }),
  );
  const torso = new THREE.CapsuleGeometry(0.23, 0.72, 4, 10);
  torso.translate(0, 0.82, 0);
  const head = new THREE.IcosahedronGeometry(0.17, 1);
  head.translate(0, 1.44, 0);
  const performerGeo = track(mergeParts([torso, head]));

  const performers: Performer[] = [];
  const addPerformer = (x: number, y: number, z: number, roams = false) => {
    const root = new THREE.Group();
    root.position.set(x, y, z);
    root.add(new THREE.Mesh(performerGeo, bodyMat));
    group.add(root);
    performers.push({ root, home: new THREE.Vector3(x, y, z), phase: performers.length * 1.7, roams });
    return root;
  };

  const singer = addPerformer(-26, S.deckY - 0.35, 0, true);
  addPerformer(S.cx + 2, S.deckY, -9); // guitar
  addPerformer(S.cx + 2, S.deckY, 9); // bass
  addPerformer(S.cx - 12, S.deckY, -15); // keys
  addPerformer(S.cx - 6, S.deckY + 1.1, 0); // drums

  // Mic stand travels with the vocalist.
  const micGeo = track(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6));
  const micMat = track(new THREE.MeshStandardMaterial({ color: 0x1a1d24, roughness: 0.4, metalness: 0.8 }));
  const mic = new THREE.Mesh(micGeo, micMat);
  mic.position.set(0.35, 0.75, 0);
  singer.add(mic);

  // Drum kit, as cylinders. From 40m away that is all a drum kit is.
  const kitMat = track(new THREE.MeshStandardMaterial({ color: 0x191c24, roughness: 0.5, metalness: 0.4 }));
  const kitParts: THREE.BufferGeometry[] = [];
  const kick = new THREE.CylinderGeometry(0.62, 0.62, 0.5, 18);
  kick.rotateX(Math.PI / 2);
  kick.translate(S.cx - 5.1, S.deckY + 1.72, 0);
  kitParts.push(kick);
  [[-0.9, 0.35], [0.9, 0.35], [-1.5, 0.28], [1.5, 0.28]].forEach(([dz, r]) => {
    const cym = new THREE.CylinderGeometry(r, r, 0.03, 14);
    cym.translate(S.cx - 5.6, S.deckY + 2.5, dz);
    kitParts.push(cym);
  });
  const kitGeo = track(mergeParts(kitParts));
  group.add(new THREE.Mesh(kitGeo, kitMat));

  const screens: Array<{ mat: THREE.ShaderMaterial; base: number }> = [
    { mat: mainScreenMat, base: 0.8 },
    { mat: imagMat, base: 0.85 },
    { mat: floorLedMat, base: 0.7 },
  ];
  let t = 0;

  return {
    group,

    setScreenMode(mode: number) {
      // The floor LED runs its own program; it is a wash, not a picture.
      mainScreenMat.uniforms.uMode.value = mode;
      imagMat.uniforms.uMode.value = mode;
    },

    setPerformersVisible(v: boolean) {
      for (const p of performers) p.root.visible = v;
      mic.visible = v;
    },

    setScreenBoost(k: number) {
      for (const s of screens) s.mat.uniforms.uBrightness.value = s.base * k;
    },

    update(dt: number, beat: number, energy: number) {
      t += dt;
      for (const p of performers) {
        const bob = Math.sin(beat * Math.PI * 2 + p.phase);
        p.root.position.y = p.home.y + Math.max(0, bob) * (0.04 + 0.14 * energy);
        p.root.rotation.y = Math.sin(t * 0.7 + p.phase) * 0.35 * (0.4 + energy);
        if (p.roams) {
          // Slow saunter up and down the thrust.
          const travel = Math.sin(t * 0.11) * 0.5 + 0.5;
          p.root.position.x = THREE.MathUtils.lerp(STAGE_FRONT - 2, S.thrustTo + 1, travel);
          p.root.position.z = Math.sin(t * 0.23) * 1.4;
        }
      }
    },

    dispose() {
      dispose.forEach((d) => d.dispose());
    },
  };
}
