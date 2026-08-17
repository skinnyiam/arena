import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { AssetRegistry, type Prototype } from './registry';
import { KIT } from './manifest';

/**
 * Character and animation library.
 *
 * Designed so that better characters are a *drop-in*, not a code change. On
 * load it looks for two optional index files:
 *
 *   public/assets/characters/index.json   ["woman-a.glb", "man-b.glb", …]
 *   public/assets/animations/index.json   ["dancing.glb", "talking.glb", …]
 *
 * If neither exists it falls back to the one character the CC0 kit ships, so
 * the venue is never empty. Drop Mixamo downloads into those folders, list the
 * filenames, and the crowd starts dancing.
 *
 * Why this works with Mixamo specifically: every Mixamo rig uses the same bone
 * names (`mixamorig:Hips`, `mixamorig:Spine`, …), so a clip exported against
 * one Mixamo character drives any other. Animation-only exports ("without
 * skin") are therefore a shared clip library — which is why animations live in
 * their own folder rather than being bound to a particular body.
 */

/** Clothing tones, multiplied over untextured bodies for crowd variety. */
const TINTS = [
  '#ffffff', '#8fb8e8', '#e8a0b4', '#f0d8a8', '#a8d8c0',
  '#c8b0e8', '#e8c090', '#90a8c8', '#d8d8d8', '#b0c8a0',
].map((hex) => new THREE.Color(hex));

export const CHARACTER_DIR = '/assets/characters/';
export const ANIMATION_DIR = '/assets/animations/';

/** Roles the crowd system asks for; each maps to the first clip that matches. */
export type ClipRole =
  | 'idle'
  | 'walk'
  | 'dance'
  | 'cheer'
  | 'talk'
  | 'sit'
  | 'drink'
  | 'clap';

/**
 * Clip names vary wildly between exports ("Hip Hop Dancing", "dance_01",
 * "mixamo.com"), so roles are matched by substring against a priority list.
 */
const ROLE_PATTERNS: Record<ClipRole, string[]> = {
  idle: ['idle', 'breathing', 'stand'],
  walk: ['walk'],
  dance: ['dance', 'dancing', 'hip hop', 'shuffle', 'twist', 'groove'],
  cheer: ['cheer', 'clap', 'applaud', 'excited', 'jump'],
  talk: ['talk', 'conversation', 'argu', 'emote-yes', 'emote-no'],
  sit: ['sit'],
  drink: ['drink', 'sipping', 'bottle'],
  clap: ['clap', 'applaud'],
};

export type CharacterLibrary = {
  /** Loaded body prototypes; at least one is always present. */
  bodies: Prototype[];
  /** Every clip found, keyed by its own name. */
  clips: Map<string, THREE.AnimationClip>;
  /** Best clip for a role, or null if nothing matched. */
  clipFor(role: ClipRole): THREE.AnimationClip | null;
  /** True once real character files (not the fallback) are in use. */
  usingDropIns: boolean;
  spawn(index?: number): SpawnedCharacter | null;
};

export type SpawnedCharacter = {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** Height in metres as loaded, before scaling. */
  nativeHeight: number;
  play(role: ClipRole, fade?: number, offset?: number): boolean;
  currentRole: ClipRole | null;
  dispose(): void;
};

async function fetchIndex(dir: string): Promise<string[]> {
  try {
    const res = await fetch(`${dir}index.json`, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter((x): x is string => typeof x === 'string');
  } catch {
    // No index file is the normal case until someone adds characters.
    return [];
  }
}

export async function buildCharacterLibrary(
  registry: AssetRegistry,
): Promise<CharacterLibrary> {
  const [bodyFiles, clipFiles] = await Promise.all([
    fetchIndex(CHARACTER_DIR),
    fetchIndex(ANIMATION_DIR),
  ]);

  const bodies: Prototype[] = [];
  const clips = new Map<string, THREE.AnimationClip>();

  // Ids keep their extension so the registry can pick the right loader —
  // Mixamo hands out .fbx, everything else tends to be .glb.
  const loadFrom = (dir: string, file: string) => registry.prototype(`${dir}${file}`);

  // Mixamo names every exported clip "mixamo.com" regardless of the motion, so
  // the filename is the only thing that identifies it. This applies to bodies
  // too: an animation downloaded *with* skin is both a character and a clip.
  const clipName = (clip: THREE.AnimationClip, file: string) =>
    clip.name && clip.name.toLowerCase() !== 'mixamo.com'
      ? clip.name
      : file.replace(/\.(glb|gltf|fbx)$/i, '');

  for (const file of bodyFiles) {
    try {
      const proto = await loadFrom(CHARACTER_DIR, file);
      bodies.push(proto);
      for (const c of proto.animations) clips.set(clipName(c, file), c);
    } catch (err) {
      console.warn(`[characters] skipped ${file}:`, err);
    }
  }

  for (const file of clipFiles) {
    try {
      const proto = await loadFrom(ANIMATION_DIR, file);
      for (const c of proto.animations) {
        // Mixamo names every animation-only export "mixamo.com"; fall back to
        // the filename so roles can still be matched.
        clips.set(clipName(c, file), c);
      }
    } catch (err) {
      console.warn(`[animations] skipped ${file}:`, err);
    }
  }

  const usingDropIns = bodies.length > 0;

  if (!usingDropIns) {
    // Fallback: the kit's single rigged character, which carries its own clips.
    const proto = await registry.prototype(KIT.characters.rigged);
    bodies.push(proto);
    for (const c of proto.animations) clips.set(c.name, c);
  }

  const clipFor = (role: ClipRole): THREE.AnimationClip | null => {
    const patterns = ROLE_PATTERNS[role];
    for (const pattern of patterns) {
      for (const [name, clip] of clips) {
        if (name.toLowerCase().includes(pattern)) return clip;
      }
    }
    return null;
  };

  /**
   * Order to substitute in when a role has no clip. Ends at "literally
   * anything", because a character with no action plays nothing at all and
   * stands frozen in bind pose — arms out, unmistakably broken. One clip in
   * the library should mean everyone does that one clip, not that everyone
   * T-poses.
   */
  const SUBSTITUTES: ClipRole[] = ['idle', 'dance', 'cheer', 'clap', 'talk', 'sit', 'drink', 'walk'];
  const firstClip = clips.size ? [...clips.values()][0] : null;

  // Resolve once — this runs per spawned character otherwise.
  const roleCache = new Map<ClipRole, THREE.AnimationClip | null>();
  const resolvedClip = (role: ClipRole) => {
    if (!roleCache.has(role)) {
      let clip = clipFor(role);
      if (!clip) {
        for (const alt of SUBSTITUTES) {
          clip = clipFor(alt);
          if (clip) break;
        }
      }
      roleCache.set(role, clip ?? firstClip);
    }
    return roleCache.get(role) ?? null;
  };

  const spawn = (index = Math.floor(Math.random() * bodies.length)): SpawnedCharacter | null => {
    const proto = bodies[index % bodies.length];
    if (!proto) return null;

    // SkeletonUtils.clone, not Object3D.clone: the latter shares the skeleton,
    // so every character would animate in perfect lockstep.
    const root = cloneSkinned(proto.root);

    // Mixamo bodies downloaded from the Animations tab carry no texture maps,
    // so every clone would otherwise be identically coloured. Tinting cloned
    // materials is the cheapest way to break up a crowd of identical people.
    const tint = TINTS[Math.floor(Math.random() * TINTS.length)];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material;
      const apply = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.color) c.color.multiply(tint);
        return c;
      };
      mesh.material = Array.isArray(src) ? src.map(apply) : apply(src as THREE.Material);
    });

    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<ClipRole, THREE.AnimationAction>();
    let currentRole: ClipRole | null = null;

    const play = (role: ClipRole, fade = 0.3, offset = 0) => {
      if (currentRole === role) return true;
      let action = actions.get(role);
      if (!action) {
        const clip = resolvedClip(role);
        if (!clip) return false;
        action = mixer.clipAction(clip, root);
        actions.set(role, action);
      }
      const prev = currentRole ? actions.get(currentRole) : undefined;
      action.reset();
      action.time = offset;
      action.setEffectiveWeight(1);
      action.play();
      if (prev && prev !== action) prev.crossFadeTo(action, fade, false);
      currentRole = role;
      return true;
    };

    return {
      root,
      mixer,
      nativeHeight: proto.size.y || 1,
      play,
      get currentRole() {
        return currentRole;
      },
      dispose() {
        mixer.stopAllAction();
        mixer.uncacheRoot(root);
      },
    };
  };

  return { bodies, clips, clipFor: resolvedClip, usingDropIns, spawn };
}
