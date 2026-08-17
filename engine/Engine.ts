import * as THREE from 'three';
import { createPipeline, QUALITY_PRESETS, type Pipeline, type Quality } from './core/renderer';
import { createSharedUniforms } from './core/uniforms';
import { CameraRig, type CameraMode, type SeatInfo } from './camera/CameraRig';
import { buildStadium, type Stadium } from './world/stadium';
import { buildStage, type Stage } from './world/stage';
import { buildCrowd, type Crowd } from './world/crowd';
import { buildRig, type Rig } from './world/rig';
import { buildFx, type Fx } from './world/fx';
import { buildDaylight, type Daylight } from './world/daylight';
import { buildExterior, type Exterior } from './world/exterior';
import { AssetRegistry } from './assets/registry';
import { buildCity, type City } from './world/city';
import { buildNpcs, type Npcs } from './world/npcs';
import { buildAudience, buildBand, type Audience, type Band } from './world/audience';
import { ProximityMixer } from './audio/proximity';
import { Sfx } from './audio/sfx';
import { venueDistance } from './audio/proximity';
import { ShowClock } from './show/clock';
import { Director } from './show/director';
import { VenueClock, type ShowSlot } from './show/schedule';
import type { AudioFeatures } from './show/analyser';
import type { LookName, Mood, Section, Song } from './show/songs';
import type { PaletteName } from './core/palette';

export type VenueState = {
  hour: number;
  clockText: string;
  slot: ShowSlot;
  minutesToNext: number;
  occupancy: number;
  dayness: number;
};

export type EngineCallbacks = {
  onSection?: (section: Section) => void;
  onSeat?: (info: SeatInfo) => void;
  onMode?: (mode: CameraMode) => void;
  onShot?: (name: string) => void;
  onStats?: (fps: number, crowd: number) => void;
  /** Fired when the venue moves into a new phase of its day. */
  onPhase?: (slot: ShowSlot) => void;
  /** ~4Hz, for the HUD clock and occupancy readout. */
  onVenue?: (state: VenueState) => void;
  /**
   * Distance-driven volume, 0..1. Multiply by the user's master level and push
   * it to the player — this is the music swelling as you approach.
   */
  onProximity?: (volume: number) => void;
  /** Walked through a gate — the UI should fade the transition. */
  onEnterVenue?: () => void;
  /** Detailed crowd is live; `dropIns` is false while using the CC0 fallback. */
  onCrowdReady?: (info: { detailed: number; dropIns: boolean }) => void;
  /** The asset-built street has finished loading (or failed). */
  onWorldReady?: (info: { props: number; error?: string }) => void;
};

export type Engine = {
  readonly clock: ShowClock;
  readonly venueClock: VenueClock;
  readonly director: Director;
  readonly cameraRig: CameraRig;
  setSong(song: Song): void;
  setTempo(bpm: number, offset: number): void;
  /** Push the player's clock in. `playing` false holds the show where it is. */
  syncTime(time: number, playing: boolean): void;
  setMicFeatures(f: AudioFeatures | null): void;
  setQuality(q: Quality): void;
  setMode(mode: CameraMode): void;
  /** Complete a gate entry: step out into the bowl. */
  enterBowl(): void;
  /** Start the effects audio graph. Must be called from a user gesture. */
  startAudio(): Promise<void>;
  setSfxVolume(v: number): void;
  /** Walk back out to the approach street. */
  exitToStreet(): void;
  nextShot(): void;
  trigger(kind: 'confetti' | 'pyro'): void;
  forceLook(look: LookName): void;
  /** Jump the venue day to an hour, 0-24. */
  setHour(hour: number): void;
  /** Sim hours per real second. 1/3600 is wall-clock. */
  setTimeScale(scale: number): void;
  /** Live lighting control, independent of the track's own mood. */
  setLighting(opts: { mood?: Mood; palette?: PaletteName }): void;
  getVenueState(): VenueState;
  dispose(): void;
};

export function createEngine(canvas: HTMLCanvasElement, cb: EngineCallbacks = {}): Engine {
  let quality: Quality = 'high';
  let preset = QUALITY_PRESETS[quality];

  const scene = new THREE.Scene();
  // Fog colour and density are owned by the time-of-day system — a night-blue
  // fog in daylight is one of the loudest possible tells.
  scene.fog = new THREE.FogExp2(0x05060c, 0.0021);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 9000);
  // Open at the far end of the approach street — you arrive at a venue on foot
  // before you're ever inside one.
  camera.position.set(508, 5.5, 26);

  const u = createSharedUniforms();

  const daylight: Daylight = buildDaylight(u, { shadows: preset.shadows });
  scene.add(daylight.group);
  scene.add(daylight.sun);
  scene.add(daylight.sun.target);
  scene.add(daylight.ambient);
  scene.add(daylight.hemi);

  const stadium: Stadium = buildStadium(u, { segments: preset.segments });
  scene.add(stadium.group);

  const exterior: Exterior = buildExterior({ segments: preset.segments });
  scene.add(exterior.group);

  // The asset-built approach loads asynchronously; the venue is usable before
  // it arrives, so nothing blocks on it.
  const registry = new AssetRegistry();
  let city: City | null = null;
  let npcs: Npcs | null = null;
  let audience: Audience | null = null;
  let band: Band | null = null;

  const stage: Stage = buildStage(u);
  scene.add(stage.group);

  const rig: Rig = buildRig(u, { beamSegments: preset.beamSegments });
  scene.add(rig.group);

  const fx: Fx = buildFx(u, { confetti: preset.confetti, sparks: preset.sparks });
  scene.add(fx.group);

  let crowd: Crowd = buildCrowd(u, { count: preset.crowd });
  scene.add(crowd.group);

  // Structure takes and receives the sun. The crowd does neither: 44,000
  // shadow-casting instances would cost more than everything else combined,
  // and at this distance nobody can tell.
  const enableShadows = (root: THREE.Object3D) => {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.Material | undefined;
      if (mat && mat.transparent) return; // beams, glows, haze
      m.castShadow = true;
      m.receiveShadow = true;
    });
  };
  enableShadows(stadium.group);
  enableShadows(stage.group);
  enableShadows(rig.group);
  // The exterior sets its own shadow flags per mesh as it builds; ink outlines
  // must stay out of the shadow pass or they cast a halo around everything.

  const clock = new ShowClock();
  // Open in the afternoon with the doors open, so the first thing you see is
  // the building in real daylight rather than a dark bowl.
  const venueClock = new VenueClock(17.1);
  venueClock.onPhaseChange = (slot) => cb.onPhase?.(slot);

  const cameraRig = new CameraRig(camera, canvas);
  cameraRig.setPickTargets(stadium.pickTargets);
  cameraRig.setWalkTargets([...exterior.walkTargets, ...stadium.pickTargets]);

  buildCity(registry)
    .then((built) => {
      if (disposed) {
        built.dispose();
        return;
      }
      city = built;
      scene.add(built.group);
      cameraRig.setWalkTargets([...built.walkTargets, ...exterior.walkTargets, ...stadium.pickTargets]);
      cb.onWorldReady?.({ props: built.propCount });
    })
    .then(async () => {
      // Interior first: detailed people in the bowl matter more than people on
      // the street, because that's where you spend the show.
      const aud = await buildAudience(registry, crowd, { pool: 34, radius: 34 });
      if (disposed) {
        aud.dispose();
        return;
      }
      audience = aud;
      scene.add(aud.group);
      cb.onCrowdReady?.({ detailed: aud.library.bodies.length, dropIns: aud.usingDropIns });

      const b = await buildBand(registry, aud.library);
      if (disposed) {
        b.dispose();
        return;
      }
      band = b;
      scene.add(b.group);
      stage.setPerformersVisible(false);
    })
    .then(() => buildNpcs(registry, { count: 44 }))
    .then((crowd) => {
      if (!crowd) return;
      if (disposed) {
        crowd.dispose();
        return;
      }
      npcs = crowd;
      scene.add(crowd.group);
    })
    .catch((err: Error) => {
      cb.onWorldReady?.({ props: 0, error: err.message });
    });
  cameraRig.onTeleport = (info) => cb.onSeat?.(info);
  cameraRig.onModeChange = (m) => cb.onMode?.(m);
  cameraRig.onShot = (n) => cb.onShot?.(n);
  cameraRig.onEnterVenue = () => cb.onEnterVenue?.();
  cameraRig.onFootstep = (running) => {
    // Concrete inside the bowl, pavement on the approach.
    const inside = venueDistance(camera.position) < 200;
    sfx.step(inside ? 'concrete' : 'pavement', running ? 1.15 : 1);
  };

  const director = new Director(rig, fx, stage, u, clock, {
    onSection: (section) => cb.onSection?.(section),
  });

  const pipeline: Pipeline = createPipeline(canvas, scene, camera, quality);

  // ---- sizing ---------------------------------------------------------------
  const resize = () => {
    const parent = canvas.parentElement;
    const w = Math.max(1, parent?.clientWidth ?? window.innerWidth);
    const h = Math.max(1, parent?.clientHeight ?? window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    pipeline.resize(w, h);
  };
  resize();

  const ro = new ResizeObserver(resize);
  if (canvas.parentElement) ro.observe(canvas.parentElement);
  window.addEventListener('resize', resize);

  // ---- loop -----------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let elapsed = 0;
  let frames = 0;
  let statAccum = 0;
  let venueAccum = 0;
  let micFeatures: AudioFeatures | null = null;
  let hasSong = false;
  let isPlaying = false;
  let disposed = false;
  const proximity = new ProximityMixer();
  const sfx = new Sfx();

  const venueState = (): VenueState => ({
    hour: venueClock.hour,
    clockText: venueClock.clockText,
    slot: venueClock.slot,
    minutesToNext: venueClock.minutesToNext,
    occupancy: crowd.occupancy,
    dayness: daylight.state.dayness,
  });

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // Clamp dt: a backgrounded tab must not fast-forward the whole venue day.
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    elapsed += dt;

    venueClock.update(dt);
    const sky = daylight.update(venueClock.hour, camera, scene);
    pipeline.setExposure(sky.exposure);
    // Bloom is a night effect. Left at full strength it turns a daylit bowl
    // into a white smear.
    pipeline.setBloomStrength(0.05 + 0.65 * sky.night);

    crowd.setOccupancy(venueClock.occupancy);
    exterior.update(dt, sky.night);
    npcs?.update(dt, camera.position);
    audience?.update(dt, camera, director.energy, clock.beats);
    band?.update(dt, director.energy, clock.beats);

    director.dayness = sky.dayness;
    director.venueMode = isPlaying
      ? 'show'
      : venueClock.slot.phase === 'closed'
        ? 'closed'
        : 'house';

    // With no track loaded the clock free-runs, so the empty venue still
    // breathes at a plausible tempo instead of freezing mid-frame.
    if (!hasSong) clock.playing = true;
    clock.update(dt);

    director.update(dt, micFeatures ?? undefined);
    cameraRig.update(dt, director.shake);

    // Crowd murmur rises as you approach and again once you're among them.
    sfx.setMurmur(
      THREE.MathUtils.clamp(1 - (venueDistance(camera.position) - 120) / 320, 0, 1) *
        (0.35 + 0.65 * venueClock.occupancy),
    );

    // Music swells as the listener closes on the building.
    const vol = proximity.update(dt, camera.position);
    if (vol !== null) cb.onProximity?.(vol);

    pipeline.setFlash(director.flash);
    pipeline.setTime(elapsed);
    pipeline.render();

    frames++;
    statAccum += dt;
    if (statAccum >= 0.5) {
      cb.onStats?.(Math.round(frames / statAccum), Math.floor(crowd.count * crowd.occupancy));
      frames = 0;
      statAccum = 0;
    }
    venueAccum += dt;
    if (venueAccum >= 0.25) {
      venueAccum = 0;
      cb.onVenue?.(venueState());
    }
  };

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && !disposed) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(frame);

  return {
    clock,
    venueClock,
    director,
    cameraRig,

    setSong(song) {
      director.setSong(song);
      clock.setTempo(song.bpm, song.offset);
      clock.reset(0);
      hasSong = true;
      exterior.setMarquee([song.artist.toUpperCase()]);
    },

    setTempo(bpm, offset) {
      clock.setTempo(bpm, offset);
    },

    syncTime(time, playing) {
      hasSong = true;
      isPlaying = playing;
      clock.playing = playing;
      if (playing) clock.syncExternal(time);
    },

    setMicFeatures(f) {
      micFeatures = f;
    },

    setQuality(next) {
      if (next === quality) return;
      quality = next;
      preset = QUALITY_PRESETS[next];
      pipeline.setBloom(preset.bloom);
      pipeline.setPixelRatioCap(preset.pixelRatio);
      daylight.setShadows(preset.shadows);
      // Only the crowd is rebuilt. The bowl's segment count is baked into one
      // big buffer and regenerating it mid-show would stall for ~a second;
      // crowd population is where the frame cost actually lives anyway.
      const occupancy = crowd.occupancy;
      scene.remove(crowd.group);
      crowd.dispose();
      crowd = buildCrowd(u, { count: preset.crowd });
      crowd.setOccupancy(occupancy);
      scene.add(crowd.group);
    },

    setMode(mode) {
      cameraRig.setMode(mode);
    },

    enterBowl() {
      cameraRig.emergeInBowl();
    },

    startAudio() {
      return sfx.resume();
    },

    setSfxVolume(v) {
      sfx.setVolume(v);
    },

    exitToStreet() {
      cameraRig.returnToStreet();
    },

    nextShot() {
      cameraRig.nextShot();
    },

    trigger(kind) {
      if (kind === 'confetti') fx.confetti();
      else fx.pyro();
    },

    forceLook(look) {
      director.forceLook(look);
    },

    setHour(hour) {
      venueClock.setHour(hour);
      daylight.update(venueClock.hour, camera, scene);
      crowd.setOccupancy(venueClock.occupancy);
      cb.onVenue?.(venueState());
    },

    setTimeScale(scale) {
      venueClock.timeScale = scale;
    },

    setLighting({ mood, palette }) {
      if (mood) director.setMood(mood);
      if (palette) director.setPalette(palette);
    },

    getVenueState: venueState,

    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', resize);
      ro.disconnect();
      sfx.dispose();
      cameraRig.dispose();
      band?.dispose();
      audience?.dispose();
      npcs?.dispose();
      city?.dispose();
      registry.dispose();
      daylight.dispose();
      exterior.dispose();
      stadium.dispose();
      stage.dispose();
      rig.dispose();
      fx.dispose();
      crowd.dispose();
      pipeline.dispose();
      scene.clear();
    },
  };
}
