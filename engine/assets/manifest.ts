/**
 * The asset kit.
 *
 * Everything here is CC0 (Kenney), downloaded into `public/assets/kit`. The
 * props are modular grid kits: each tile occupies a 2×2 unit footprint, which
 * makes a street layout a matter of stamping a grid rather than placing
 * objects by hand.
 *
 * IMPORTANT — the folder structure is not cosmetic. Every .glb references its
 * texture as the *relative* URI `Textures/colormap.png`, and each kit ships a
 * different colormap. Flatten them into one directory and the wrong palette
 * (or none at all) resolves — which renders every model pure white, since
 * these models carry no vertex colour and get 100% of their colour from that
 * one atlas. Hence: one folder per kit, each with its own Textures/.
 *
 *   public/assets/kit/<kit>/<model>.glb
 *   public/assets/kit/<kit>/Textures/colormap.png
 *
 * To add a pack: drop it in as its own folder, keeping its Textures/ beside
 * the models, then reference ids as "<kit>/<model>".
 */

export const KIT_BASE = '/assets/kit/';

/** One kit tile is 2 units across; the world is in metres. */
export const KIT_UNIT = 2;
/** Metres per tile in the finished world. A road tile becomes 8m — two lanes. */
export const TILE = 8;
export const KIT_SCALE = TILE / KIT_UNIT;

/** Asset id, always "<kit>/<model>". */
export type KitId = string;

export const KIT = {
  road: {
    straight: 'city/road-straight',
    lightposts: 'city/road-straight-lightposts',
    corner: 'city/road-corner',
    intersection: 'city/road-intersection',
    split: 'city/road-split',
  },
  ground: {
    pavement: 'city/pavement',
    fountain: 'city/pavement-fountain',
    grass: 'city/grass',
    grassTrees: 'city/grass-trees',
    grassTreesTall: 'city/grass-trees-tall',
    floor: 'basic/floor',
    floorDetail: 'basic/floor-detail',
  },
  buildings: [
    'city/building-small-a',
    'city/building-small-b',
    'city/building-small-c',
    'city/building-small-d',
    'city/building-garage',
  ],
  vehicles: [
    'racing/vehicle-truck-red',
    'racing/vehicle-truck-green',
    'racing/vehicle-truck-purple',
    'racing/vehicle-truck-yellow',
  ],
  motorcycle: 'racing/vehicle-motorcycle',
  tree: 'basic/tree',
  street: {
    borderStraight: 'basic/border-straight',
    borderCorner: 'basic/border-corner',
    wall: 'basic/wall',
    wallHigh: 'basic/wall-high',
    wallCorner: 'basic/wall-corner',
    gate: 'basic/wall-gate',
    column: 'basic/column',
    statue: 'basic/statue',
    banner: 'basic/banner',
    stairs: 'basic/stairs',
    tents: 'racing/decoration-tents',
    forest: 'racing/decoration-forest',
  },
  characters: {
    /** 32 clips: idle, walk, sprint, sit, emote-yes/no, … */
    rigged: 'basic/character-soldier',
    simple: 'platformer/character',
  },
} as const;

/** Animation clips shipped with `characters.rigged`, by role. */
export const CLIPS = {
  idle: 'idle',
  walk: 'walk',
  run: 'sprint',
  sit: 'sit',
  talkYes: 'emote-yes',
  talkNo: 'emote-no',
  static: 'static',
} as const;

export function kitUrl(id: KitId): string {
  return `${KIT_BASE}${id}.glb`;
}
