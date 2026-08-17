import * as THREE from 'three';
import type { SharedUniforms } from '@/engine/core/uniforms';

/**
 * Time of day, in a hand-painted sky.
 *
 * The venue has to work at 4pm with doors open and at 10pm mid-headliner, and
 * those are genuinely different designs — not one scene with the lights turned
 * down. A light show barely exists in daylight: real daytime stadium sets carry
 * on LED walls, pyro, confetti and the crowd. So this module owns not just the
 * sky, but everything downstream of the sun: fill light, fog, exposure, and how
 * much the beams are allowed to read at all.
 *
 * The sky itself is stylised to match the rest of the art direction — banded
 * gradients and flat, thresholded cloud shapes rather than an atmospheric
 * scattering model, which would fight the cel shading everywhere else.
 */

type SkyStop = {
  hour: number;
  zenith: string;
  horizon: string;
  ground: string;
  cloudLit: string;
  cloudShade: string;
  sun: string;
  sunIntensity: number;
  ambient: string;
  ambientIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  fog: string;
  fogDensity: number;
  exposure: number;
  stars: number;
  /**
   * How "night" it is, 0..1. Drives everything the show does: beam
   * visibility, haze, screen brightness, whether phone torches read.
   */
  night: number;
};

const STOPS: SkyStop[] = [
  {
    hour: 0,
    zenith: '#070b1e', horizon: '#16214a', ground: '#080a14',
    cloudLit: '#2b3766', cloudShade: '#141c3c',
    sun: '#33406b', sunIntensity: 0,
    ambient: '#26304f', ambientIntensity: 0.38,
    hemiSky: '#33437a', hemiGround: '#0a0c16', hemiIntensity: 0.3,
    fog: '#0a0e1e', fogDensity: 0.0016, exposure: 1.15, stars: 1, night: 1,
  },
  {
    hour: 5,
    zenith: '#111c44', horizon: '#4a3a6e', ground: '#0d0f1c',
    cloudLit: '#5b5088', cloudShade: '#2b2a53',
    sun: '#7a5f95', sunIntensity: 0.08,
    ambient: '#2e3760', ambientIntensity: 0.36,
    hemiSky: '#42528c', hemiGround: '#111320', hemiIntensity: 0.32,
    fog: '#161a33', fogDensity: 0.0015, exposure: 1.12, stars: 0.7, night: 0.93,
  },
  {
    hour: 6.6,
    zenith: '#2f6ec4', horizon: '#ffb178', ground: '#3a2a2c',
    cloudLit: '#ffd9b8', cloudShade: '#b4809b',
    sun: '#ffc089', sunIntensity: 1.5,
    ambient: '#7d7796', ambientIntensity: 0.34,
    hemiSky: '#a9b7dd', hemiGround: '#4a3a34', hemiIntensity: 0.42,
    fog: '#9e8296', fogDensity: 0.0007, exposure: 1.05, stars: 0.1, night: 0.5,
  },
  {
    hour: 9,
    zenith: '#2f86e8', horizon: '#c8e2fb', ground: '#5a6068',
    cloudLit: '#ffffff', cloudShade: '#bcd3ef',
    sun: '#fff6e4', sunIntensity: 2.3,
    ambient: '#c3d2e6', ambientIntensity: 0.32,
    hemiSky: '#d8ebff', hemiGround: '#6f6a60', hemiIntensity: 0.55,
    fog: '#c4dcf3', fogDensity: 0.00035, exposure: 1.0, stars: 0, night: 0.06,
  },
  {
    hour: 12.5,
    zenith: '#2b82ef', horizon: '#d6ecff', ground: '#646a72',
    cloudLit: '#ffffff', cloudShade: '#c6dcf5',
    sun: '#ffffff', sunIntensity: 2.6,
    ambient: '#d2dff0', ambientIntensity: 0.32,
    hemiSky: '#e2f1ff', hemiGround: '#7a746a', hemiIntensity: 0.6,
    fog: '#d2e7fb', fogDensity: 0.00025, exposure: 0.98, stars: 0, night: 0,
  },
  {
    hour: 16.5,
    zenith: '#3184e6', horizon: '#dbe9f8', ground: '#5f6570',
    cloudLit: '#fff6ea', cloudShade: '#c3d5ee',
    sun: '#fff4dc', sunIntensity: 2.35,
    ambient: '#ccd8ea', ambientIntensity: 0.32,
    hemiSky: '#dcecff', hemiGround: '#736c62', hemiIntensity: 0.55,
    fog: '#cbe0f5', fogDensity: 0.00035, exposure: 1.0, stars: 0, night: 0.05,
  },
  {
    hour: 18.4,
    zenith: '#3a6fc0', horizon: '#ffc98a', ground: '#4a3b34',
    cloudLit: '#ffe3c0', cloudShade: '#c98fa0',
    sun: '#ffb877', sunIntensity: 1.7,
    ambient: '#a08fa0', ambientIntensity: 0.3,
    hemiSky: '#c0aec4', hemiGround: '#54423a', hemiIntensity: 0.45,
    fog: '#c39e9c', fogDensity: 0.0005, exposure: 1.02, stars: 0, night: 0.3,
  },
  {
    hour: 19.4,
    zenith: '#2b3f86', horizon: '#ff7a52', ground: '#2a2030',
    cloudLit: '#ffa585', cloudShade: '#7d5580',
    sun: '#ff8552', sunIntensity: 0.8,
    ambient: '#5c5478', ambientIntensity: 0.28,
    hemiSky: '#7b6f9e', hemiGround: '#241c2c', hemiIntensity: 0.38,
    fog: '#6c4f68', fogDensity: 0.0012, exposure: 1.05, stars: 0.12, night: 0.66,
  },
  {
    hour: 20.6,
    zenith: '#101a44', horizon: '#5b3070', ground: '#0e1020',
    cloudLit: '#5f4380', cloudShade: '#2a2350',
    sun: '#6d4489', sunIntensity: 0.1,
    ambient: '#2c3660', ambientIntensity: 0.34,
    hemiSky: '#3b4b84', hemiGround: '#0b0d18', hemiIntensity: 0.32,
    fog: '#221f42', fogDensity: 0.0015, exposure: 1.1, stars: 0.6, night: 0.92,
  },
  {
    hour: 24,
    zenith: '#070b1e', horizon: '#16214a', ground: '#080a14',
    cloudLit: '#2b3766', cloudShade: '#141c3c',
    sun: '#33406b', sunIntensity: 0,
    ambient: '#26304f', ambientIntensity: 0.38,
    hemiSky: '#33437a', hemiGround: '#0a0c16', hemiIntensity: 0.3,
    fog: '#0a0e1e', fogDensity: 0.0016, exposure: 1.15, stars: 1, night: 1,
  },
];

export type SkyState = {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  fog: THREE.Color;
  fogDensity: number;
  exposure: number;
  stars: number;
  /** 1 at midnight, 0 at noon. */
  night: number;
  /** 1 - night. */
  dayness: number;
  sunDir: THREE.Vector3;
};

const DOME_R = 1500;

/** Where the sun sits for a given hour. Sunrise ~6, zenith ~12, sunset ~18. */
export function sunDirection(hour: number, out = new THREE.Vector3()): THREE.Vector3 {
  const t = (hour - 6) / 12; // 0 at sunrise, 1 at sunset
  const elev = Math.sin(Math.PI * t) * 1.12; // radians; negative overnight
  const az = Math.PI * t + Math.PI * 0.14; // tracks east → west
  const c = Math.cos(elev);
  return out.set(c * Math.cos(az), Math.sin(elev), c * Math.sin(az)).normalize();
}

export type Daylight = {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  state: SkyState;
  setShadows(enabled: boolean): void;
  update(hour: number, camera: THREE.Camera, scene: THREE.Scene): SkyState;
  dispose(): void;
};

export function buildDaylight(u: SharedUniforms, opts: { shadows?: boolean } = {}): Daylight {
  const group = new THREE.Group();
  group.name = 'daylight';

  const state: SkyState = {
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    ground: new THREE.Color(),
    sunColor: new THREE.Color(),
    sunIntensity: 0,
    fog: new THREE.Color(),
    fogDensity: 0.002,
    exposure: 1,
    stars: 1,
    night: 1,
    dayness: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
  };

  const cloudLit = new THREE.Color('#ffffff');
  const cloudShade = new THREE.Color('#c6dcf5');

  const domeGeo = new THREE.SphereGeometry(DOME_R, 48, 28);
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: state.zenith },
      uHorizon: { value: state.horizon },
      uGround: { value: state.ground },
      uCloudLit: { value: cloudLit },
      uCloudShade: { value: cloudShade },
      uSunDir: { value: state.sunDir },
      uSunColor: { value: state.sunColor },
      uSunPower: { value: 0 },
      uNight: { value: 1 },
      uCloudCover: { value: 0.52 },
      uTime: u.uTime,
      uAccentA: u.uAccentA,
      uEnergy: u.uEnergy,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        // The dome is re-centred on the camera every frame, so the local
        // position *is* the view direction — no parallax, no huge far plane.
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform vec3  uZenith;
      uniform vec3  uHorizon;
      uniform vec3  uGround;
      uniform vec3  uCloudLit;
      uniform vec3  uCloudShade;
      uniform vec3  uSunDir;
      uniform vec3  uSunColor;
      uniform vec3  uAccentA;
      uniform float uSunPower;
      uniform float uNight;
      uniform float uCloudCover;
      uniform float uTime;
      uniform float uEnergy;

      varying vec3 vDir;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }

      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * vnoise(p);
          p *= 2.07;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;

        // --- gradient, gently stepped so the sky reads as painted ----------
        float t = pow(clamp(h, 0.0, 1.0), 0.5);
        float banded = floor(t * 8.0 + 0.5) / 8.0;
        t = mix(t, banded, 0.45);
        vec3 col = mix(uHorizon, uZenith, t);
        col = mix(uGround, col, smoothstep(-0.13, 0.012, h));

        // --- sun / moon ----------------------------------------------------
        float sd = max(dot(dir, uSunDir), 0.0);
        float disc = smoothstep(0.99955, 0.99975, sd);
        // The widest lobe used to be pow(sd, 4.0) — that spreads across most of
        // the sky and, once bloom got hold of it, veiled the whole frame.
        float halo = pow(sd, 320.0) * 0.55 + pow(sd, 26.0) * 0.16 + pow(sd, 9.0) * 0.04;
        col += uSunColor * (halo + disc * 7.0) * uSunPower;

        float md = max(dot(dir, -uSunDir), 0.0);
        float moon = smoothstep(0.99955, 0.99978, md);
        col += vec3(0.95, 0.96, 1.0) * (moon * 3.2 + pow(md, 900.0) * 0.5) * uNight;

        // --- cloud deck ----------------------------------------------------
        // Projected onto a flat plane overhead, then thresholded into two flat
        // tones. Soft, blended clouds would fight the cel shading below.
        float hy = max(h, 0.035);
        vec2 cp = dir.xz / hy;
        vec2 wind = vec2(uTime * 0.0055, uTime * 0.0021);
        float n = fbm(cp * 0.42 + wind) * 0.68 + fbm(cp * 1.15 - wind * 1.6) * 0.32;

        float body = smoothstep(uCloudCover, uCloudCover + 0.05, n);
        float lit = smoothstep(uCloudCover + 0.085, uCloudCover + 0.15, n);
        vec3 cloud = mix(uCloudShade, uCloudLit, lit);
        // Rim the cloud edges toward the sun colour — cheap, and it does most
        // of the work of making them feel lit from somewhere.
        cloud += uSunColor * pow(sd, 6.0) * 0.35 * uSunPower;

        float horizonFade = smoothstep(0.015, 0.17, h);
        col = mix(col, cloud, clamp(body * horizonFade, 0.0, 1.0));

        // --- night wash ----------------------------------------------------
        float band = exp(-pow(max(0.0, h) * 6.5, 2.0));
        col += (uAccentA * 0.16 * uEnergy + vec3(0.05, 0.06, 0.1)) * band * uNight;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: true,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -100; // paint first, behind everything
  group.add(dome);

  // ---- stars --------------------------------------------------------------
  const starCount = 1600;
  const spos = new Float32Array(starCount * 3);
  const sphase = new Float32Array(starCount);
  const sbright = new Float32Array(starCount);
  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const y = Math.pow(Math.random(), 0.55);
    const r = Math.sqrt(1 - y * y);
    spos[i * 3] = Math.cos(theta) * r * DOME_R * 0.94;
    spos[i * 3 + 1] = y * DOME_R * 0.94;
    spos[i * 3 + 2] = Math.sin(theta) * r * DOME_R * 0.94;
    sphase[i] = Math.random() * 6.283;
    sbright[i] = 0.25 + Math.pow(Math.random(), 3) * 0.75;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(spos, 3));
  starGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(sphase, 1));
  starGeo.setAttribute('aBright', new THREE.Float32BufferAttribute(sbright, 1));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uTime: u.uTime, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      attribute float aBright;
      uniform float uTime;
      uniform float uFade;
      varying float vB;
      void main() {
        vB = aBright * (0.72 + 0.28 * sin(uTime * 1.3 + aPhase)) * uFade;
        gl_PointSize = 1.0 + aBright * 1.8;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vB;
      void main() {
        if (vB <= 0.01) discard;
        float a = smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(vec3(0.86, 0.9, 1.0) * vB * a, a * vB);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -99;
  group.add(stars);

  // ---- lights -------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 0);
  sun.castShadow = !!opts.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -260;
  sc.right = 260;
  sc.top = 260;
  sc.bottom = -260;
  sc.near = 1;
  sc.far = 1200;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.8;

  const ambient = new THREE.AmbientLight(0x26304f, 1.1);
  const hemi = new THREE.HemisphereLight(0x33437a, 0x0a0c16, 0.7);

  const cA = new THREE.Color();
  const cB = new THREE.Color();
  const mixInto = (target: THREE.Color, ka: string, kb: string, k: number) =>
    target.copy(cA.set(ka)).lerp(cB.set(kb), k);

  const lerpStops = (hour: number) => {
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < STOPS.length - 2 && STOPS[i + 1].hour <= h) i++;
    const a = STOPS[i];
    const b = STOPS[i + 1];
    const k = THREE.MathUtils.clamp((h - a.hour) / Math.max(1e-6, b.hour - a.hour), 0, 1);

    mixInto(state.zenith, a.zenith, b.zenith, k);
    mixInto(state.horizon, a.horizon, b.horizon, k);
    mixInto(state.ground, a.ground, b.ground, k);
    mixInto(state.sunColor, a.sun, b.sun, k);
    mixInto(state.fog, a.fog, b.fog, k);
    mixInto(cloudLit, a.cloudLit, b.cloudLit, k);
    mixInto(cloudShade, a.cloudShade, b.cloudShade, k);

    state.sunIntensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, k);
    state.fogDensity = THREE.MathUtils.lerp(a.fogDensity, b.fogDensity, k);
    state.exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, k);
    state.stars = THREE.MathUtils.lerp(a.stars, b.stars, k);
    state.night = THREE.MathUtils.lerp(a.night, b.night, k);
    state.dayness = 1 - state.night;

    mixInto(ambient.color, a.ambient, b.ambient, k);
    ambient.intensity = THREE.MathUtils.lerp(a.ambientIntensity, b.ambientIntensity, k);
    mixInto(hemi.color, a.hemiSky, b.hemiSky, k);
    mixInto(hemi.groundColor, a.hemiGround, b.hemiGround, k);
    hemi.intensity = THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, k);
  };

  let shadowsAllowed = !!opts.shadows;

  return {
    group,
    sun,
    ambient,
    hemi,
    state,

    setShadows(enabled: boolean) {
      shadowsAllowed = enabled;
      sun.castShadow = enabled && state.sunIntensity > 0.45;
    },

    update(hour, camera, scene) {
      lerpStops(hour);
      sunDirection(hour, state.sunDir);

      group.position.copy(camera.position);

      domeMat.uniforms.uSunPower.value = THREE.MathUtils.clamp(state.sunIntensity / 2.4, 0, 1.5);
      domeMat.uniforms.uNight.value = state.night;
      starMat.uniforms.uFade.value = state.stars;

      sun.color.copy(state.sunColor);
      sun.intensity = state.sunIntensity;
      sun.position.copy(state.sunDir).multiplyScalar(420);
      sun.target.position.set(0, 0, 0);
      sun.target.updateMatrixWorld();
      // Shadow mapping is only worth its cost while the sun is actually up.
      sun.castShadow = shadowsAllowed && state.sunIntensity > 0.45;

      const fog = scene.fog as THREE.FogExp2 | null;
      if (fog) {
        fog.color.copy(state.fog);
        fog.density = state.fogDensity;
      }

      u.uDayness.value = state.dayness;
      return state;
    },

    dispose() {
      domeGeo.dispose();
      domeMat.dispose();
      starGeo.dispose();
      starMat.dispose();
    },
  };
}
