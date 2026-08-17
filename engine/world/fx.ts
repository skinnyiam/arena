import * as THREE from 'three';
import { ARENA, STAGE_FRONT } from './layout';
import { createGlowTexture } from './materials';
import type { SharedUniforms } from '@/engine/core/uniforms';

export type Fx = {
  group: THREE.Group;
  /** Fire the confetti cannons. */
  confetti(): void;
  /** Fire the upstage pyro. */
  pyro(): void;
  update(dt: number, energy: number): void;
  dispose(): void;
};

const GRAVITY = 9.81;

export function buildFx(u: SharedUniforms, opts: { confetti?: number; sparks?: number } = {}): Fx {
  const group = new THREE.Group();
  group.name = 'fx';

  // ---------------------------------------------------------------------------
  // Confetti
  // ---------------------------------------------------------------------------
  const N = opts.confetti ?? 1500;
  const confGeo = new THREE.PlaneGeometry(0.17, 0.28);
  const confMat = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    toneMapped: true,
    transparent: false,
  });
  const conf = new THREE.InstancedMesh(confGeo, confMat, N);
  conf.frustumCulled = false;
  conf.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(conf);

  const cp = new Float32Array(N * 3);
  const cv = new Float32Array(N * 3);
  const crot = new Float32Array(N * 3);
  const cvrot = new Float32Array(N * 3);
  const clife = new Float32Array(N); // seconds remaining; <= 0 is parked
  const cflut = new Float32Array(N);

  // Cannons: stage lip corners, plus the B-stage so the floor crowd gets hit too.
  const cannons = [
    new THREE.Vector3(STAGE_FRONT - 1, 3.2, -15),
    new THREE.Vector3(STAGE_FRONT - 1, 3.2, 15),
    new THREE.Vector3(STAGE_FRONT - 1, 3.2, -5),
    new THREE.Vector3(STAGE_FRONT - 1, 3.2, 5),
    new THREE.Vector3(ARENA.stage.thrustTo, 2.6, -5),
    new THREE.Vector3(ARENA.stage.thrustTo, 2.6, 5),
  ];

  const confColors = ['#ff2d95', '#22d3ee', '#ffd166', '#ffffff', '#7c3aed', '#00ffa3'].map(
    (h) => new THREE.Color(h),
  );
  for (let i = 0; i < N; i++) conf.setColorAt(i, confColors[i % confColors.length]);
  if (conf.instanceColor) conf.instanceColor.needsUpdate = true;

  // Park everything off-screen at zero scale until fired.
  const m4 = new THREE.Matrix4();
  const zeroScale = new THREE.Vector3(0, 0, 0);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < N; i++) conf.setMatrixAt(i, m4.compose(p.set(0, -50, 0), q, zeroScale));
  conf.instanceMatrix.needsUpdate = true;

  let confCursor = 0;
  const fireConfetti = () => {
    const burst = Math.min(N, 900);
    for (let k = 0; k < burst; k++) {
      const i = confCursor;
      confCursor = (confCursor + 1) % N;
      const c = cannons[k % cannons.length];
      cp[i * 3] = c.x + (Math.random() - 0.5) * 1.2;
      cp[i * 3 + 1] = c.y;
      cp[i * 3 + 2] = c.z + (Math.random() - 0.5) * 1.2;
      // Angled up and out over the floor.
      const speed = 13 + Math.random() * 11;
      const spread = 0.55;
      cv[i * 3] = speed * (0.42 + Math.random() * 0.5);
      cv[i * 3 + 1] = speed * (0.72 + Math.random() * 0.4);
      cv[i * 3 + 2] = (Math.random() - 0.5) * speed * spread;
      crot[i * 3] = Math.random() * 6.28;
      crot[i * 3 + 1] = Math.random() * 6.28;
      crot[i * 3 + 2] = Math.random() * 6.28;
      cvrot[i * 3] = (Math.random() - 0.5) * 12;
      cvrot[i * 3 + 1] = (Math.random() - 0.5) * 12;
      cvrot[i * 3 + 2] = (Math.random() - 0.5) * 12;
      cflut[i] = Math.random() * 6.28;
      clife[i] = 13 + Math.random() * 7;
    }
  };

  // ---------------------------------------------------------------------------
  // Pyro / sparks
  // ---------------------------------------------------------------------------
  const SN = opts.sparks ?? 1800;
  const sparkGeo = new THREE.BufferGeometry();
  const sp = new Float32Array(SN * 3);
  const sv = new Float32Array(SN * 3);
  const slife = new Float32Array(SN);
  const smax = new Float32Array(SN);
  const salpha = new Float32Array(SN);
  for (let i = 0; i < SN; i++) sp[i * 3 + 1] = -80; // parked below the world
  sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const sparkAlpha = new THREE.Float32BufferAttribute(salpha, 1);
  sparkAlpha.setUsage(THREE.DynamicDrawUsage);
  sparkGeo.setAttribute('aAlpha', sparkAlpha);
  (sparkGeo.getAttribute('position') as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);

  const sparkTex = createGlowTexture(64, 0.02);
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: sparkTex } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vA;
      void main() {
        vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(150.0 / max(0.001, -mv.z) * (0.4 + aAlpha), 1.0, 26.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uTex;
      varying float vA;
      void main() {
        if (vA <= 0.01) discard;
        float t = texture2D(uTex, gl_PointCoord).a;
        // White-hot core cooling to orange as the spark dies.
        vec3 hot = mix(vec3(1.6, 0.42, 0.08), vec3(2.2, 1.9, 1.5), pow(vA, 1.6));
        gl_FragColor = vec4(hot * t * vA, t * vA);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  sparks.renderOrder = 6;
  group.add(sparks);

  const pyroPads: THREE.Vector3[] = [];
  for (let i = 0; i < 7; i++) {
    pyroPads.push(new THREE.Vector3(ARENA.stage.cx + 4, ARENA.stage.deckY, -15 + i * 5));
  }

  let sparkCursor = 0;
  const firePyro = () => {
    const burst = Math.min(SN, 1200);
    for (let k = 0; k < burst; k++) {
      const i = sparkCursor;
      sparkCursor = (sparkCursor + 1) % SN;
      const pad = pyroPads[k % pyroPads.length];
      sp[i * 3] = pad.x + (Math.random() - 0.5) * 0.4;
      sp[i * 3 + 1] = pad.y;
      sp[i * 3 + 2] = pad.z + (Math.random() - 0.5) * 0.4;
      // Near-vertical jet with a little scatter: a gerb, not a firework.
      const up = 17 + Math.random() * 13;
      sv[i * 3] = (Math.random() - 0.5) * 2.2;
      sv[i * 3 + 1] = up;
      sv[i * 3 + 2] = (Math.random() - 0.5) * 2.2;
      smax[i] = 1.5 + Math.random() * 1.1;
      slife[i] = smax[i];
    }
  };

  // ---------------------------------------------------------------------------
  // Atmospheric haze
  // ---------------------------------------------------------------------------
  // Sprites, kept few, huge and very faint. Their job is to catch the beams near
  // the deck so the air itself looks thick; any more opacity and they read as
  // grey blobs floating in the venue.
  const hazeTex = createGlowTexture(256, 0.0);
  const hazeSprites: THREE.Sprite[] = [];
  const hazeMats: THREE.SpriteMaterial[] = [];
  const hazeSeed: Array<{ x: number; z: number; s: number; ph: number }> = [];
  for (let i = 0; i < 20; i++) {
    const mat = new THREE.SpriteMaterial({
      map: hazeTex,
      color: new THREE.Color('#8fa8d8'),
      transparent: true,
      opacity: 0.035,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    const s = new THREE.Sprite(mat);
    const x = -56 + Math.random() * 92;
    const z = (Math.random() - 0.5) * 70;
    const scale = 26 + Math.random() * 40;
    s.position.set(x, 2 + Math.random() * 12, z);
    s.scale.setScalar(scale);
    s.renderOrder = 5;
    group.add(s);
    hazeSprites.push(s);
    hazeMats.push(mat);
    hazeSeed.push({ x, z, s: scale, ph: Math.random() * 6.28 });
  }

  let t = 0;
  const posAttr = sparkGeo.getAttribute('position') as THREE.BufferAttribute;

  return {
    group,
    confetti: fireConfetti,
    pyro: firePyro,

    update(dt: number, energy: number) {
      t += dt;

      // --- confetti ---
      let anyConf = false;
      for (let i = 0; i < N; i++) {
        if (clife[i] <= 0) continue;
        anyConf = true;
        clife[i] -= dt;

        const ix = i * 3;
        // Paper: heavy drag, and a flutter force that makes it tumble sideways.
        const drag = 1 - Math.min(0.9, dt * 1.6);
        cv[ix] *= drag;
        cv[ix + 2] *= drag;
        cv[ix + 1] = cv[ix + 1] * drag - GRAVITY * 0.34 * dt;
        cv[ix] += Math.sin(t * 3.1 + cflut[i]) * 1.6 * dt;
        cv[ix + 2] += Math.cos(t * 2.6 + cflut[i]) * 1.6 * dt;

        cp[ix] += cv[ix] * dt;
        cp[ix + 1] += cv[ix + 1] * dt;
        cp[ix + 2] += cv[ix + 2] * dt;

        crot[ix] += cvrot[ix] * dt;
        crot[ix + 1] += cvrot[ix + 1] * dt;
        crot[ix + 2] += cvrot[ix + 2] * dt;

        if (cp[ix + 1] <= 0.02) {
          // Settle on the deck rather than vanishing mid-air.
          cp[ix + 1] = 0.02;
          cv[ix] = cv[ix + 1] = cv[ix + 2] = 0;
          cvrot[ix] = cvrot[ix + 1] = cvrot[ix + 2] = 0;
          clife[i] = Math.min(clife[i], 4);
        }

        const fade = Math.min(1, clife[i] / 2.5);
        e.set(crot[ix], crot[ix + 1], crot[ix + 2]);
        q.setFromEuler(e);
        p.set(cp[ix], cp[ix + 1], cp[ix + 2]);
        conf.setMatrixAt(i, m4.compose(p, q, one.set(fade, fade, fade)));
        if (clife[i] <= 0) conf.setMatrixAt(i, m4.compose(p.set(0, -50, 0), q, zeroScale));
      }
      if (anyConf) conf.instanceMatrix.needsUpdate = true;

      // --- sparks ---
      let anySpark = false;
      for (let i = 0; i < SN; i++) {
        if (slife[i] <= 0) {
          if (salpha[i] !== 0) {
            salpha[i] = 0;
            anySpark = true;
          }
          continue;
        }
        anySpark = true;
        slife[i] -= dt;
        const ix = i * 3;
        sv[ix + 1] -= GRAVITY * 1.15 * dt;
        sv[ix] *= 1 - dt * 0.9;
        sv[ix + 2] *= 1 - dt * 0.9;
        sp[ix] += sv[ix] * dt;
        sp[ix + 1] += sv[ix + 1] * dt;
        sp[ix + 2] += sv[ix + 2] * dt;
        salpha[i] = Math.max(0, slife[i] / smax[i]);
        if (slife[i] <= 0) {
          sp[ix + 1] = -80;
          salpha[i] = 0;
        }
      }
      if (anySpark) {
        posAttr.needsUpdate = true;
        sparkAlpha.needsUpdate = true;
      }

      // --- haze ---
      for (let i = 0; i < hazeSprites.length; i++) {
        const s = hazeSprites[i];
        const seed = hazeSeed[i];
        s.position.x = seed.x + Math.sin(t * 0.05 + seed.ph) * 6;
        s.position.z = seed.z + Math.cos(t * 0.04 + seed.ph) * 6;
        const puff = 1 + Math.sin(t * 0.3 + seed.ph) * 0.12;
        s.scale.setScalar(seed.s * puff);
        hazeMats[i].opacity = (0.012 + 0.03 * u.uHaze.value) * (0.6 + 0.6 * energy);
      }
    },

    dispose() {
      confGeo.dispose();
      confMat.dispose();
      conf.dispose();
      sparkGeo.dispose();
      sparkMat.dispose();
      sparkTex.dispose();
      hazeMats.forEach((m) => m.dispose());
      hazeTex.dispose();
    },
  };
}
