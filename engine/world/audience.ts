import * as THREE from 'three';
import { AssetRegistry } from '@/engine/assets/registry';
import {
  buildCharacterLibrary,
  type CharacterLibrary,
  type ClipRole,
  type SpawnedCharacter,
} from '@/engine/assets/characters';
import { STAGE_FOCUS } from './layout';
import type { Crowd } from './crowd';

/**
 * Level-of-detail audience.
 *
 * Skinned characters can't be instanced — each needs its own skeleton and
 * AnimationMixer — so a stadium's worth of them is out of the question. What
 * works is a small pool that *follows the viewer*: the nearest few dozen
 * attendees are swapped for real animated bodies, and the instanced crowd hides
 * exactly those slots so nobody appears twice. Walk somewhere else and the pool
 * re-targets to whoever is nearest now.
 *
 * The effect is that everyone within conversational distance is a person, and
 * everyone beyond it is a silhouette — which is also true of a real stadium at
 * night.
 */

export type AudienceOptions = {
  /** Detailed characters alive at once. Each costs a mixer and draw calls. */
  pool?: number;
  /** Beyond this distance nobody is upgraded. */
  radius?: number;
  /** Nobody is upgraded closer than this — that's your own row. */
  minDistance?: number;
  /** Target height in metres. */
  height?: number;
};

type Member = {
  char: SpawnedCharacter;
  /** Crowd slot currently occupied, or -1 when parked. */
  slot: number;
  /** Personality: how likely they are to dance rather than stand. */
  liveliness: number;
  phase: number;
  nextChange: number;
};

export type Audience = {
  group: THREE.Group;
  /** True when real character files were found in public/assets/characters. */
  usingDropIns: boolean;
  library: CharacterLibrary;
  activeCount: number;
  update(dt: number, camera: THREE.Camera, energy: number, beat: number): void;
  dispose(): void;
};

export async function buildAudience(
  registry: AssetRegistry,
  crowd: Crowd,
  opts: AudienceOptions = {},
): Promise<Audience> {
  const poolSize = opts.pool ?? 34;
  const radius = opts.radius ?? 34;
  const minDistance = opts.minDistance ?? 3.4;
  const height = opts.height ?? 1.76;

  const group = new THREE.Group();
  group.name = 'audience-lod';

  const library = await buildCharacterLibrary(registry);

  const members: Member[] = [];
  for (let i = 0; i < poolSize; i++) {
    const char = library.spawn(i);
    if (!char) break;
    const scale = height / char.nativeHeight;
    char.root.scale.setScalar(scale);
    char.root.visible = false;
    char.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false; // dozens of skinned shadow casters is not worth it
        m.receiveShadow = true;
      }
    });
    group.add(char.root);
    members.push({
      char,
      slot: -1,
      liveliness: Math.random(),
      phase: Math.random() * 6.283,
      nextChange: 1 + Math.random() * 4,
    });
  }

  const hidden = new Set<number>();
  const camPos = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const toSlot = new THREE.Vector3();
  const slotPos = new THREE.Vector3();
  let retarget = 0;

  /** Indices of the crowd slots nearest the camera, nearest first. */
  const nearest: Array<{ i: number; d: number }> = [];

  const pickNearest = (camera: THREE.Camera, visibleCount: number) => {
    nearest.length = 0;
    const pos = crowd.positions;
    const r2 = radius * radius;
    const min2 = minDistance * minDistance;
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camFwd);

    for (let i = 0; i < visibleCount; i++) {
      const dx = pos[i * 3] - camPos.x;
      const dy = pos[i * 3 + 1] - camPos.y;
      const dz = pos[i * 3 + 2] - camPos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > r2) continue;

      // Keep the sightline clear. Upgrading the people immediately in front of
      // a seated viewer puts a full-detail head in the middle of the frame and
      // hides the stage — the one thing you came to look at.
      if (d < min2) continue;
      if (d < 18 * 18) {
        const inv = 1 / Math.sqrt(d);
        toSlot.set(dx * inv, dy * inv, dz * inv);
        if (toSlot.dot(camFwd) > 0.86) continue; // dead ahead, close: skip
      }

      nearest.push({ i, d });
      // Keep the list small; a full sort of 40k entries every retarget is waste.
      if (nearest.length > poolSize * 4) {
        nearest.sort((a, b) => a.d - b.d);
        nearest.length = poolSize * 2;
      }
    }
    nearest.sort((a, b) => a.d - b.d);
  };

  /** What this person is doing right now. */
  const roleFor = (m: Member, energy: number): ClipRole => {
    if (energy > 0.62 && m.liveliness > 0.28) return 'dance';
    if (energy > 0.42 && m.liveliness > 0.6) return 'cheer';
    if (m.liveliness < 0.22) return 'talk';
    return 'idle';
  };

  return {
    group,
    usingDropIns: library.usingDropIns,
    library,
    get activeCount() {
      return members.filter((m) => m.slot >= 0).length;
    },

    update(dt, camera, energy, beat) {
      // Re-targeting walks the whole crowd array, so do it a few times a second
      // rather than every frame — people don't teleport between frames anyway.
      retarget -= dt;
      if (retarget <= 0) {
        retarget = 0.35;
        const visible = Math.floor(crowd.count * crowd.occupancy);
        pickNearest(camera, visible);

        hidden.clear();
        for (let k = 0; k < members.length; k++) {
          const m = members[k];
          const target = nearest[k];
          if (!target) {
            m.slot = -1;
            m.char.root.visible = false;
            continue;
          }
          m.slot = target.i;
          hidden.add(target.i);

          slotPos.fromArray(crowd.positions, target.i * 3);
          m.char.root.position.copy(slotPos);
          m.char.root.rotation.y = crowd.facings[target.i];
          m.char.root.visible = true;
        }
        crowd.setHidden(hidden);
      }

      for (const m of members) {
        if (m.slot < 0) continue;
        m.char.mixer.update(dt);

        m.nextChange -= dt;
        if (m.nextChange <= 0) {
          m.nextChange = 2.5 + Math.random() * 5;
          const role = roleFor(m, energy);
          // If the clip library has no dance (the CC0 fallback doesn't), this
          // returns false and we fall back to something that does exist.
          if (!m.char.play(role)) m.char.play('idle');
        }

        // Whatever clips exist, add a beat-locked bob so the crowd is visibly
        // on the music rather than looping at its own unrelated tempo.
        const bounce = Math.max(0, Math.sin(beat * Math.PI * 2 + m.phase));
        m.char.root.position.y =
          crowd.positions[m.slot * 3 + 1] + bounce * (0.02 + 0.13 * energy) * m.liveliness;
      }
    },

    dispose() {
      for (const m of members) m.char.dispose();
      members.length = 0;
      crowd.setHidden(new Set());
    },
  };
}

/**
 * The band. Same character system, parked on stage — the abstract capsules read
 * fine at 60m but not from the front row, which is exactly where people look.
 */
export type Band = {
  group: THREE.Group;
  update(dt: number, energy: number, beat: number): void;
  dispose(): void;
};

export async function buildBand(
  registry: AssetRegistry,
  library?: CharacterLibrary,
): Promise<Band> {
  const lib = library ?? (await buildCharacterLibrary(registry));
  const group = new THREE.Group();
  group.name = 'band';

  // Vocalist downstage on the thrust, the rest across the deck.
  const marks: Array<{ pos: THREE.Vector3; role: ClipRole; roams?: boolean }> = [
    { pos: new THREE.Vector3(-26, 2.05, 0), role: 'dance', roams: true },
    { pos: new THREE.Vector3(-44, 2.4, -9), role: 'idle' },
    { pos: new THREE.Vector3(-44, 2.4, 9), role: 'idle' },
    { pos: new THREE.Vector3(-58, 2.4, -15), role: 'idle' },
    { pos: new THREE.Vector3(-52, 3.5, 0), role: 'idle' },
  ];

  const members: Array<{ char: SpawnedCharacter; home: THREE.Vector3; roams: boolean; phase: number }> = [];
  marks.forEach((mark, i) => {
    const char = lib.spawn(i);
    if (!char) return;
    char.root.scale.setScalar(1.8 / char.nativeHeight);
    char.root.position.copy(mark.pos);
    char.root.rotation.y = Math.PI / 2; // face the crowd
    group.add(char.root);
    if (!char.play(mark.role)) char.play('idle');
    members.push({ char, home: mark.pos.clone(), roams: !!mark.roams, phase: i * 1.3 });
  });

  let t = 0;
  return {
    group,
    update(dt, energy, beat) {
      t += dt;
      for (const m of members) {
        m.char.mixer.update(dt);
        const bounce = Math.max(0, Math.sin(beat * Math.PI * 2 + m.phase));
        m.char.root.position.y = m.home.y + bounce * (0.03 + 0.16 * energy);
        if (m.roams) {
          // Slow saunter along the thrust.
          m.char.root.position.x = m.home.x + Math.sin(t * 0.12) * 9;
          m.char.root.position.z = Math.sin(t * 0.25) * 1.6;
          m.char.root.rotation.y = Math.PI / 2 + Math.sin(t * 0.4) * 0.5;
        }
      }
    },
    dispose() {
      for (const m of members) m.char.dispose();
      members.length = 0;
    },
  };
}

/** Where the band looks, for camera framing. */
export const BAND_FOCUS = STAGE_FOCUS;
