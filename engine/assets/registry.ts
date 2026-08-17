import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { kitUrl } from './manifest';

/**
 * Asset loading and instancing.
 *
 * Two jobs. First, load each .glb exactly once and hand out prototypes with
 * their real measured bounds — asset kits never agree on scale or origin, so
 * everything gets measured rather than assumed.
 *
 * Second, and more importantly: turn a prototype into an InstancedMesh set. A
 * street needs hundreds of copies of a dozen models, and placing them as
 * individual Object3Ds would mean hundreds of draw calls. A kit model often
 * contains several sub-meshes (a truck has six), so each sub-mesh becomes its
 * own InstancedMesh with the sub-mesh's local transform baked in — one draw
 * call per sub-mesh, no matter how many copies are placed.
 */

export type Prototype = {
  id: string;
  root: THREE.Object3D;
  /** Measured bounding box in the file's own units. */
  size: THREE.Vector3;
  /** Lowest point, so props can be sat on the ground exactly. */
  minY: number;
  center: THREE.Vector3;
  animations: THREE.AnimationClip[];
};

type SubMesh = {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** Transform of this mesh relative to the prototype root. */
  local: THREE.Matrix4;
};

/**
 * Resolve an asset id to a URL.
 *
 * Ids without an extension are kit models (`city/road-straight`). Ids *with*
 * one are paths under /public and used verbatim — which is how drop-in
 * characters and animations arrive.
 */
function resolveUrl(id: string): string {
  if (/\.(glb|gltf|fbx)$/i.test(id)) {
    const path = id.startsWith('/') ? id : `/${id}`;
    // Mixamo names files after the animation — "Hip Hop Dancing.fbx" — so
    // spaces and punctuation in asset paths are the norm, not an edge case.
    return encodeURI(path);
  }
  return kitUrl(id);
}

export class AssetRegistry {
  private gltf = new GLTFLoader();
  private fbx = new FBXLoader();
  private cache = new Map<string, Promise<Prototype>>();
  private disposables = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();

  /** Load (or return cached) a kit model by id. */
  prototype(id: string): Promise<Prototype> {
    const hit = this.cache.get(id);
    if (hit) return hit;

    const url = resolveUrl(id);
    // Mixamo only exports FBX and Collada — no glTF — so FBX has to be a
    // first-class input or every download needs converting by hand first.
    const isFbx = /\.fbx$/i.test(url);

    const p = new Promise<Prototype>((resolve, reject) => {
      const onLoad = (loaded: { scene?: THREE.Group; animations?: THREE.AnimationClip[] } | THREE.Group) => {
          const asGltf = loaded as { scene?: THREE.Group; animations?: THREE.AnimationClip[] };
          const root: THREE.Object3D = asGltf.scene ?? (loaded as THREE.Group);
          const animations: THREE.AnimationClip[] =
            asGltf.animations ?? (loaded as THREE.Group).animations ?? [];
          root.updateMatrixWorld(true);

          const box = new THREE.Box3().setFromObject(root);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());

          root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            this.disposables.add(m.geometry);
            const mat = m.material as THREE.Material | THREE.Material[];
            if (Array.isArray(mat)) mat.forEach((x) => this.disposables.add(x));
            else this.disposables.add(mat);
          });

          resolve({ id, root, size, minY: box.min.y, center, animations });
      };

      const onError = (err: unknown) =>
        reject(new Error(`Failed to load asset "${id}" from ${url}: ${String(err)}`));

      if (isFbx) this.fbx.load(url, onLoad, undefined, onError);
      else this.gltf.load(url, onLoad, undefined, onError);
    });

    this.cache.set(id, p);
    return p;
  }

  /** Load several in parallel. */
  prototypes(ids: readonly string[]): Promise<Prototype[]> {
    return Promise.all(ids.map((id) => this.prototype(id)));
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables.clear();
    this.cache.clear();
  }
}

/** Flatten a prototype into its drawable sub-meshes, with baked transforms. */
export function collectSubMeshes(proto: Prototype): SubMesh[] {
  const out: SubMesh[] = [];
  proto.root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(proto.root.matrixWorld).invert();
  proto.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const local = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    out.push({ geometry: m.geometry, material: m.material, local });
  });
  return out;
}

/**
 * A pool of instances of one prototype.
 *
 * Placements are written by index; call `commit()` once after a batch. Unused
 * slots are collapsed to zero scale, so a pool can be over-allocated safely.
 */
export class Instancer {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private locals: THREE.Matrix4[] = [];
  private used = 0;

  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3();
  private _up = new THREE.Vector3(0, 1, 0);
  private _zero = new THREE.Vector3(0, 0, 0);

  constructor(
    proto: Prototype,
    readonly capacity: number,
    opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {},
  ) {
    this.group.name = opts.name ?? `inst:${proto.id}`;
    for (const sub of collectSubMeshes(proto)) {
      const im = new THREE.InstancedMesh(sub.geometry, sub.material as THREE.Material, capacity);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = opts.castShadow ?? true;
      im.receiveShadow = opts.receiveShadow ?? true;
      im.frustumCulled = false; // instances span far more than the source bounds
      im.count = 0;
      this.meshes.push(im);
      this.locals.push(sub.local);
      this.group.add(im);
    }
  }

  /** Place the next free instance. Returns its index, or -1 when full. */
  place(position: THREE.Vector3Like, rotationY = 0, scale = 1): number {
    if (this.used >= this.capacity) return -1;
    const i = this.used++;
    this.setAt(i, position, rotationY, scale);
    return i;
  }

  setAt(i: number, position: THREE.Vector3Like, rotationY = 0, scale = 1) {
    this._q.setFromAxisAngle(this._up, rotationY);
    this._s.setScalar(scale);
    this._m.compose(
      { x: position.x, y: position.y, z: position.z } as THREE.Vector3,
      this._q,
      this._s,
    );
    for (let k = 0; k < this.meshes.length; k++) {
      const world = new THREE.Matrix4().multiplyMatrices(this._m, this.locals[k]);
      this.meshes[k].setMatrixAt(i, world);
    }
  }

  commit() {
    for (const m of this.meshes) {
      m.count = this.used;
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }

  get count() {
    return this.used;
  }

  /** Hide everything without deallocating. */
  clear() {
    this.used = 0;
    for (const m of this.meshes) m.count = 0;
  }

  dispose() {
    for (const m of this.meshes) m.dispose();
    this.meshes.length = 0;
    void this._zero;
  }
}
