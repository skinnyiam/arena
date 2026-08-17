import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { AssetRegistry } from '@/engine/assets/registry';
import { CLIPS, KIT } from '@/engine/assets/manifest';

/**
 * The crowd outside: people walking up to the gates, and people standing
 * around in groups talking.
 *
 * These are skinned meshes, so they can't be instanced the way the props are —
 * each one needs its own skeleton and its own AnimationMixer. That puts a hard
 * ceiling on the count, so the budget goes on the ones you can actually see:
 * a few dozen animated characters near the approach, rather than a thousand
 * distant ones nobody reads.
 *
 * `basic/character-soldier` ships 32 clips; `walk`, `idle`, `sit` and the two
 * `emote-*` gestures are all this needs.
 */

export type NpcOptions = {
  /** Animated characters. Each costs a mixer + its own draw calls. */
  count?: number;
  /** Real-world height in metres. */
  height?: number;
};

type Behaviour = 'walking' | 'standing' | 'talking';

type Npc = {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string;
  behaviour: Behaviour;
  /** Metres per second. */
  speed: number;
  /** Where they're heading; walkers pick a new one on arrival. */
  target: THREE.Vector3;
  /** Facing, smoothed toward the direction of travel. */
  yaw: number;
  /** Countdown before a standing NPC does something else. */
  timer: number;
  home: THREE.Vector3;
};

export type Npcs = {
  group: THREE.Group;
  count: number;
  update(dt: number, cameraPos: THREE.Vector3): void;
  dispose(): void;
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clothing variety, since the kit ships exactly one character. */
const TINTS = [
  '#ffffff', '#e8d6c0', '#c8d8e8', '#e0c0c8', '#d8d0b8',
  '#b8c8d0', '#e8c8a0', '#c0c0d8', '#d0e0c8', '#e8e0d0',
];

export async function buildNpcs(
  registry: AssetRegistry,
  opts: NpcOptions = {},
): Promise<Npcs> {
  const count = opts.count ?? 44;
  const height = opts.height ?? 1.78;
  const group = new THREE.Group();
  group.name = 'npcs';
  const r = rng(0xbeef);

  const proto = await registry.prototype(KIT.characters.rigged);
  const scale = height / (proto.size.y || 1);

  const npcs: Npc[] = [];
  const materials: THREE.Material[] = [];

  /** Somewhere on the pavement, heading toward the gates. */
  const walkTarget = (out: THREE.Vector3) =>
    out.set(232 + r() * 24, 0, (r() < 0.5 ? -1 : 1) * (5 + r() * 9));

  for (let i = 0; i < count; i++) {
    // SkeletonUtils.clone is required here: Object3D.clone() shares the
    // skeleton, so every character would animate as one.
    const root = cloneSkinned(proto.root);
    root.scale.setScalar(scale);

    // Give each a slightly different outfit tone. Materials are cloned so the
    // tint doesn't leak back into the shared prototype.
    const tint = new THREE.Color(TINTS[Math.floor(r() * TINTS.length)]);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      const src = m.material as THREE.Material;
      const cloned = src.clone() as THREE.MeshStandardMaterial;
      if (cloned.color) cloned.color.multiply(tint);
      m.material = cloned;
      materials.push(cloned);
    });

    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const clip of proto.animations) {
      actions.set(clip.name, mixer.clipAction(clip, root));
    }

    // Two thirds are streaming toward the gates; the rest are stood about.
    const walking = r() < 0.66;
    const behaviour: Behaviour = walking ? 'walking' : r() < 0.5 ? 'talking' : 'standing';

    const start = walking
      ? new THREE.Vector3(250 + r() * 270, 0, (r() < 0.5 ? -1 : 1) * (4 + r() * 12))
      : // Standers cluster near the tents and the forecourt.
        new THREE.Vector3(244 + r() * 60, 0, (r() < 0.5 ? -1 : 1) * (14 + r() * 40));

    root.position.copy(start);
    group.add(root);

    const npc: Npc = {
      root,
      mixer,
      actions,
      current: '',
      behaviour,
      speed: 1.1 + r() * 0.5,
      target: walkTarget(new THREE.Vector3()),
      yaw: 0,
      timer: 2 + r() * 6,
      home: start.clone(),
    };

    // Desync the clips, or the whole crowd marches in lockstep.
    play(npc, walking ? CLIPS.walk : CLIPS.idle, r() * 3);
    npcs.push(npc);
  }

  function play(npc: Npc, name: string, offset = 0, fade = 0.25) {
    if (npc.current === name) return;
    const next = npc.actions.get(name);
    if (!next) return;
    const prev = npc.current ? npc.actions.get(npc.current) : undefined;
    next.reset();
    next.time = offset;
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    npc.current = name;
  }

  const dir = new THREE.Vector3();
  const forward = new THREE.Vector3();

  return {
    group,
    count: npcs.length,

    update(dt: number, cameraPos: THREE.Vector3) {
      for (const npc of npcs) {
        const distSq = npc.root.position.distanceToSquared(cameraPos);
        // Beyond ~140m a walk cycle is a couple of pixels. Skip the mixer and
        // keep the transform update — the silhouette still moves.
        const near = distSq < 140 * 140;
        if (near) npc.mixer.update(dt);

        if (npc.behaviour === 'walking') {
          dir.subVectors(npc.target, npc.root.position);
          dir.y = 0;
          const d = dir.length();
          if (d < 2.5) {
            // Arrived at the gates — send them round to the far end again, so
            // the approach always has a steady flow of people on it.
            npc.root.position.set(500 + Math.random() * 40, 0, (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 12));
            walkTarget(npc.target);
            continue;
          }
          dir.divideScalar(d);
          npc.root.position.addScaledVector(dir, npc.speed * dt);

          const wanted = Math.atan2(dir.x, dir.z);
          npc.yaw += shortestAngle(npc.yaw, wanted) * Math.min(1, dt * 6);
          npc.root.rotation.y = npc.yaw;
          play(npc, CLIPS.walk);
        } else {
          npc.timer -= dt;
          if (npc.timer <= 0) {
            npc.timer = 3 + Math.random() * 7;
            if (npc.behaviour === 'talking') {
              // A gesture, then back to standing — reads as conversation.
              play(npc, Math.random() < 0.5 ? CLIPS.talkYes : CLIPS.talkNo, 0, 0.2);
              window.setTimeout(() => play(npc, CLIPS.idle, 0, 0.3), 1400);
            } else {
              play(npc, CLIPS.idle);
            }
          }
          // Standers face roughly toward the building.
          forward.set(232 - npc.root.position.x, 0, -npc.root.position.z);
          npc.root.rotation.y = Math.atan2(forward.x, forward.z);
        }
      }
    },

    dispose() {
      for (const npc of npcs) {
        npc.mixer.stopAllAction();
        npc.mixer.uncacheRoot(npc.root);
      }
      for (const m of materials) m.dispose();
      npcs.length = 0;
    },
  };
}

/** Shortest signed turn from a to b, so characters never spin the long way. */
function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
