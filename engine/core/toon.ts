import * as THREE from 'three';

/**
 * Cel shading.
 *
 * Two things make an image read as anime rather than as 3D: light that steps
 * between flat bands instead of falling off smoothly, and a black ink line
 * around every form. This module provides both.
 *
 * The outline is an inverted hull — the mesh drawn again, back faces only,
 * pushed outward along its normals in view space. It's a decades-old trick and
 * it beats screen-space edge detection here for three reasons: the line weight
 * is authored per object, it survives any post-processing chain, and it costs
 * one extra draw call instead of an extra full-scene pass.
 */

const gradientCache = new Map<string, THREE.DataTexture>();

/**
 * Banded gradient ramp for MeshToonMaterial. `steps` is the number of flat
 * light levels; 3 is the sweet spot — 2 reads as a cheap trick, 5 stops
 * reading as cel shading at all.
 */
export function toonGradient(steps = 3, shadowFloor = 0.32): THREE.DataTexture {
  const key = `${steps}:${shadowFloor}`;
  const hit = gradientCache.get(key);
  if (hit) return hit;

  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    // Bias the ramp so the lit band is wide and the shadow band is decisive —
    // an even split makes everything look half in shadow.
    const t = steps === 1 ? 1 : i / (steps - 1);
    const level = shadowFloor + (1 - shadowFloor) * Math.pow(t, 0.72);
    const v = Math.round(THREE.MathUtils.clamp(level, 0, 1) * 255);
    data.set([v, v, v, 255], i * 4);
  }

  const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientCache.set(key, tex);
  return tex;
}

export type ToonOptions = {
  color: THREE.ColorRepresentation;
  steps?: number;
  shadowFloor?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
};

export function makeToon(opts: ToonOptions): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({
    color: opts.color,
    gradientMap: toonGradient(opts.steps ?? 3, opts.shadowFloor ?? 0.32),
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.emissive !== undefined) {
    m.emissive = new THREE.Color(opts.emissive);
    m.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  return m;
}

/** Flat unlit colour — signage faces, LED panels, anything self-lit. */
export function makeFlat(color: THREE.ColorRepresentation, intensity = 1) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    toneMapped: true,
  });
}

const OUTLINE_VERT = /* glsl */ `
uniform float uThickness;

void main() {
  vec3 nrm = normal;
  vec4 local = vec4(position, 1.0);

  #ifdef USE_INSTANCING
    // Strip the instance scale off the normal so non-uniformly scaled
    // instances don't get lopsided outlines.
    vec3 sc = vec3(
      length(instanceMatrix[0].xyz),
      length(instanceMatrix[1].xyz),
      length(instanceMatrix[2].xyz)
    );
    mat3 irot = mat3(
      instanceMatrix[0].xyz / sc.x,
      instanceMatrix[1].xyz / sc.y,
      instanceMatrix[2].xyz / sc.z
    );
    nrm = irot * (nrm / max(sc, vec3(1e-4)));
    local = instanceMatrix * local;
  #endif

  vec4 mv = modelViewMatrix * local;
  vec3 n = normalize(normalMatrix * nrm);

  // Expand in view space and scale by distance, so the ink line holds a
  // roughly constant screen-space weight instead of vanishing at range.
  float dist = max(0.001, -mv.z);
  mv.xyz += n * uThickness * dist * 0.0016;

  gl_Position = projectionMatrix * mv;
}
`;

const OUTLINE_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
void main() {
  gl_FragColor = vec4(uColor, 1.0);
}
`;

export function outlineMaterial(thickness = 1, color: THREE.ColorRepresentation = 0x0b0d14) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uThickness: { value: thickness },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    side: THREE.BackSide,
    // Outlines are opaque geometry behind the object, so they need real depth.
    depthWrite: true,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}

/**
 * Give a mesh an ink line. Returns the outline mesh, already parented to the
 * same object as the original so it moves with it.
 *
 * Works with InstancedMesh: the outline shares the source's `instanceMatrix`
 * attribute by reference, so it costs one draw call no matter the count.
 */
export function inkOutline(
  mesh: THREE.Mesh | THREE.InstancedMesh,
  thickness = 1,
  color: THREE.ColorRepresentation = 0x0b0d14,
): THREE.Mesh {
  const mat = outlineMaterial(thickness, color);

  let outline: THREE.Mesh;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    const src = mesh as THREE.InstancedMesh;
    const im = new THREE.InstancedMesh(src.geometry, mat, src.count);
    im.instanceMatrix = src.instanceMatrix;
    im.frustumCulled = src.frustumCulled;
    outline = im;
  } else {
    outline = new THREE.Mesh(mesh.geometry, mat);
  }

  outline.name = `${mesh.name || 'mesh'}__ink`;
  outline.castShadow = false;
  outline.receiveShadow = false;
  // Draw before the surface so the fill always wins the depth test on the
  // interior, leaving only the rim visible.
  outline.renderOrder = (mesh.renderOrder ?? 0) - 1;
  mesh.add(outline);
  return outline;
}

/** Ink every non-transparent mesh under a subtree. */
export function inkSubtree(root: THREE.Object3D, thickness = 1, color?: THREE.ColorRepresentation) {
  const targets: Array<THREE.Mesh> = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.name.endsWith('__ink')) return;
    const mat = m.material as THREE.Material | undefined;
    if (!mat || mat.transparent) return;
    targets.push(m);
  });
  for (const m of targets) inkOutline(m, thickness, color);
}
