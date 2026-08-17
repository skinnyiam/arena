import * as THREE from 'three';
import { AssetRegistry, Instancer, type Prototype } from '@/engine/assets/registry';
import { KIT, TILE } from '@/engine/assets/manifest';

/**
 * The approach: a street, a car park and a forecourt, built from real models
 * on a tile grid.
 *
 * The kit is modular at 2 units per tile, scaled to TILE metres here, so the
 * whole layout is grid stamping — which is both how these kits are meant to be
 * used and the only way to dress this much ground without hand-placing
 * thousands of objects.
 *
 * Every prop goes through an Instancer, so the entire street costs roughly one
 * draw call per distinct sub-mesh rather than one per object.
 */

/**
 * Which way a straight road tile runs in its own file. Kenney's city tiles are
 * authored running along Z; the approach street runs along X, hence the
 * quarter turn. If roads ever render crossways, this is the single line to flip.
 */
const ROAD_YAW = Math.PI / 2;

export const CITY = {
  /** Street centreline runs along X at z = 0. */
  street: { zCentre: 0, xNear: 236, xFar: 524 },
  pavementZ: TILE,
  buildingRows: [2.5, 3.5],
  carPark: { xMin: 288, xMax: 448, zMin: 44, zMax: 140 },
  /** Nothing is placed inside this radius — that's the venue's own forecourt. */
  keepClear: 226,
  /** Half-width of the clear corridor down the street, in metres. */
  corridorHalf: 12,
} as const;

export type City = {
  group: THREE.Group;
  /** Flat ground the walk controller stands on. */
  walkTargets: THREE.Mesh[];
  /** Approximate prop count, for the stats readout. */
  propCount: number;
  dispose(): void;
};

/** Deterministic RNG so the street is identical on every load. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scaling, from measured bounds rather than assumption.
 *
 * A fixed scale factor only works if every model is exactly the kit's nominal
 * tile size, and they are not — so tiles left visible gaps between them and
 * props came out at wildly wrong sizes next to each other. Each helper below
 * derives the scale from the prototype's real Box3, and returns the Y offset
 * that sits it exactly on the ground.
 */

/** Fit a ground tile so its footprint is exactly TILE metres — tiles must abut. */
function fitTile(proto: Prototype) {
  const footprint = Math.max(proto.size.x, proto.size.z) || 1;
  const scale = TILE / footprint;
  return { scale, groundY: -proto.minY * scale };
}

/** Fit a prop to a real-world length along its longest horizontal axis. */
function fitLength(proto: Prototype, metres: number) {
  const longest = Math.max(proto.size.x, proto.size.z) || 1;
  const scale = metres / longest;
  return { scale, groundY: -proto.minY * scale };
}

/** Fit a prop to a real-world height. */
function fitHeight(proto: Prototype, metres: number) {
  const scale = metres / (proto.size.y || 1);
  return { scale, groundY: -proto.minY * scale };
}

export async function buildCity(registry: AssetRegistry): Promise<City> {
  const group = new THREE.Group();
  group.name = 'city';
  const r = rng(0x5eed);

  const ids = [
    KIT.road.straight,
    KIT.road.lightposts,
    KIT.ground.pavement,
    KIT.ground.grass,
    KIT.ground.grassTrees,
    ...KIT.buildings,
    ...KIT.vehicles,
    KIT.motorcycle,
    KIT.tree,
    KIT.street.borderStraight,
    KIT.street.tents,
  ];
  const loaded = await registry.prototypes(ids);
  const byId = new Map(loaded.map((p) => [p.id, p]));
  const get = (id: string) => {
    const p = byId.get(id);
    if (!p) throw new Error(`city: missing prototype ${id}`);
    return p;
  };

  const instancers: Instancer[] = [];
  const pool = (id: string, capacity: number, opts?: { castShadow?: boolean }) => {
    const inst = new Instancer(get(id), capacity, {
      castShadow: opts?.castShadow ?? true,
      receiveShadow: true,
      name: `city:${id}`,
    });
    instancers.push(inst);
    group.add(inst.group);
    return inst;
  };

  const inKeepClear = (x: number, z: number) => Math.hypot(x / 1.3, z) < CITY.keepClear;

  // ---- road ----------------------------------------------------------------
  const road = pool(KIT.road.straight, 64, { castShadow: false });
  const roadLamps = pool(KIT.road.lightposts, 24);
  {
    const f = fitTile(get(KIT.road.straight));
    const fl = fitTile(get(KIT.road.lightposts));
    let i = 0;
    for (let x = CITY.street.xNear; x <= CITY.street.xFar; x += TILE, i++) {
      const lamp = i % 4 === 2;
      const target = lamp ? roadLamps : road;
      const ff = lamp ? fl : f;
      target.place({ x, y: ff.groundY, z: CITY.street.zCentre }, ROAD_YAW, ff.scale);
    }
  }

  // ---- pavement either side -----------------------------------------------
  const pavement = pool(KIT.ground.pavement, 220, { castShadow: false });
  {
    const f = fitTile(get(KIT.ground.pavement));
    for (let x = CITY.street.xNear - TILE; x <= CITY.street.xFar; x += TILE) {
      for (const z of [-CITY.pavementZ, CITY.pavementZ]) {
        pavement.place({ x, y: f.groundY, z }, 0, f.scale);
      }
    }
  }

  // NOTE: basic/border-straight was used as a kerb here and removed — it is a
  // chunky boundary wall, and at tile scale it walled the street off in tan.
  // The pavement tiles already carry their own kerb edge.

  // ---- shopfronts and blocks behind the pavement ---------------------------
  const buildingPools = KIT.buildings.map((id) => pool(id, 48));
  {
    for (let x = CITY.street.xNear; x <= CITY.street.xFar; x += TILE) {
      for (const side of [-1, 1]) {
        for (const row of CITY.buildingRows) {
          const z = side * TILE * row;
          if (inKeepClear(x, z)) continue;
          // Leave occasional gaps so it reads as a street, not a solid wall.
          if (r() < 0.18) continue;
          const pick = Math.floor(r() * buildingPools.length);
          const proto = get(KIT.buildings[pick]);
          const f = fitTile(proto);
          // Face the street.
          const yaw = side < 0 ? 0 : Math.PI;
          buildingPools[pick].place({ x, y: f.groundY, z }, yaw + (r() < 0.12 ? Math.PI / 2 : 0), f.scale);
        }
      }
    }
  }

  // ---- car park ------------------------------------------------------------
  const parkGround = pool(KIT.ground.pavement, 340, { castShadow: false });
  {
    const f = fitTile(get(KIT.ground.pavement));
    for (let x = CITY.carPark.xMin; x <= CITY.carPark.xMax; x += TILE) {
      for (let z = CITY.carPark.zMin; z <= CITY.carPark.zMax; z += TILE) {
        if (inKeepClear(x, z)) continue;
        parkGround.place({ x, y: f.groundY - 0.02, z }, 0, f.scale);
      }
    }
  }

  const vehiclePools = KIT.vehicles.map((id) => pool(id, 60));
  let parked = 0;
  {
    // Bays in rows, nose-in, with the odd empty space.
    for (let z = CITY.carPark.zMin + TILE; z <= CITY.carPark.zMax - TILE; z += TILE * 2) {
      for (let x = CITY.carPark.xMin + TILE / 2; x <= CITY.carPark.xMax - TILE; x += TILE * 0.75) {
        if (inKeepClear(x, z)) continue;
        if (r() < 0.22) continue; // empty bay
        const pick = Math.floor(r() * vehiclePools.length);
        const proto = get(KIT.vehicles[pick]);
        const f = fitLength(proto, 4.6);
        const yaw = (r() < 0.5 ? 0 : Math.PI) + (r() - 0.5) * 0.06;
        vehiclePools[pick].place({ x, y: f.groundY, z }, yaw, f.scale);
        parked++;
      }
    }
  }

  // A few bikes near the entrance.
  const bikes = pool(KIT.motorcycle, 14);
  {
    const f = fitLength(get(KIT.motorcycle), 2.1);
    for (let i = 0; i < 12; i++) {
      const x = 262 + i * 3.2;
      const z = -34 - (i % 3) * 2.4;
      if (inKeepClear(x, z)) continue;
      bikes.place({ x, y: f.groundY, z }, Math.PI / 2 + (r() - 0.5) * 0.2, f.scale);
    }
  }

  // ---- greenery and dressing ----------------------------------------------
  const trees = pool(KIT.tree, 120);
  {
    const f = fitHeight(get(KIT.tree), 8.5);
    for (let x = CITY.street.xNear; x <= CITY.street.xFar; x += TILE * 2) {
      for (const side of [-1, 1]) {
        // Behind the pavement, never over the carriageway — camera moves and
        // the walk controller both travel down the middle of the street.
        const z = side * (TILE * 1.75);
        if (inKeepClear(x, z)) continue;
        if (r() < 0.45) continue;
        trees.place({ x, y: f.groundY, z: z + (r() - 0.5) * 1.5 }, r() * 6.28, f.scale * (0.8 + r() * 0.5));
      }
    }
    // A belt of planting along the far edges of the site.
    for (let i = 0; i < 46; i++) {
      const x = 250 + r() * 300;
      const z = (r() < 0.5 ? -1 : 1) * (150 + r() * 90);
      if (inKeepClear(x, z)) continue;
      if (Math.abs(z) < CITY.corridorHalf) continue;
      trees.place({ x, y: f.groundY, z }, r() * 6.28, f.scale * (0.9 + r() * 0.7));
    }
  }

  const grass = pool(KIT.ground.grassTrees, 90, { castShadow: false });
  {
    const f = fitTile(get(KIT.ground.grassTrees));
    for (let i = 0; i < 80; i++) {
      const x = 240 + r() * 320;
      const z = (r() < 0.5 ? -1 : 1) * (100 + r() * 130);
      if (inKeepClear(x, z)) continue;
      grass.place({ x, y: f.groundY - 0.05, z }, Math.floor(r() * 4) * (Math.PI / 2), f.scale);
    }
  }

  // Merch/food tents clustered on the forecourt approach.
  const tents = pool(KIT.street.tents, 12);
  {
    const f = fitLength(get(KIT.street.tents), 7);
    for (let i = 0; i < 8; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const x = 250 + Math.floor(i / 2) * 22;
      const z = side * (46 + (i % 3) * 6);
      tents.place({ x, y: f.groundY, z }, side < 0 ? 0 : Math.PI, f.scale);
    }
  }

  for (const inst of instancers) inst.commit();

  // ---- ground plane the walk controller uses -------------------------------
  // Raycasting thousands of instanced tiles per frame would be wasteful when
  // the whole approach is dead flat; one invisible plane answers every query.
  const groundGeo = new THREE.PlaneGeometry(1400, 900);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new THREE.MeshBasicMaterial({ visible: false });
  const walkPlane = new THREE.Mesh(groundGeo, groundMat);
  walkPlane.name = 'city-walk-plane';
  walkPlane.position.set(380, 0, 0);
  group.add(walkPlane);

  const propCount = instancers.reduce((n, i) => n + i.count, 0);

  return {
    group,
    walkTargets: [walkPlane],
    propCount,
    dispose() {
      for (const inst of instancers) inst.dispose();
      groundGeo.dispose();
      groundMat.dispose();
    },
  };
}
