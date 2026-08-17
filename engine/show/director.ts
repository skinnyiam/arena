import * as THREE from 'three';
import { Palette, type PaletteName } from '@/engine/core/palette';
import type { SharedUniforms } from '@/engine/core/uniforms';
import { SCREEN } from '@/engine/world/materials';
import { ARENA, STAGE_FRONT, STAGE_FOCUS } from '@/engine/world/layout';
import type { Fixture, Rig } from '@/engine/world/rig';
import type { Fx } from '@/engine/world/fx';
import type { Stage } from '@/engine/world/stage';
import type { ShowClock } from './clock';
import type { AudioFeatures } from './analyser';
import { moodFor, resolveArc, sectionAt, sectionIndexAt, type LookName, type Mood, type Section, type Song } from './songs';

export type DirectorEvents = {
  onSection?: (section: Section, index: number) => void;
};

/** What the venue is doing when no set is being played. */
export type VenueMode = 'closed' | 'house' | 'show';

/** Doors open, people finding their seats. Working light, no show. */
const HOUSE_SECTION: Section = {
  bar: 0,
  look: 'house',
  energy: 0.3,
  phones: 0.04,
  label: 'House lights',
};

/** Nobody in, nothing on. */
const CLOSED_SECTION: Section = {
  bar: 0,
  look: 'blackout',
  energy: 0.05,
  phones: 0,
  label: 'Closed',
};

/** Deterministic 2D hash — used for "random" positions that repeat on rewind. */
function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * A point on the audience surface, parameterised as (across, depth).
 *
 * `depth` 0 is the barrier and 1 is the back of the upper deck; the bowl rises
 * as it recedes, so a single call gives lighting patterns a target that actually
 * lands on people instead of hanging in mid-air.
 */
function audiencePoint(across: number, depth: number, out: THREE.Vector3): THREE.Vector3 {
  const d = THREE.MathUtils.clamp(depth, 0, 1);
  const x = THREE.MathUtils.lerp(STAGE_FRONT + 10, 112, d);
  const halfZ = THREE.MathUtils.lerp(20, 74, d);
  const y = THREE.MathUtils.lerp(0.6, 34, Math.pow(d, 1.75));
  return out.set(x, y, THREE.MathUtils.clamp(across, -1.4, 1.4) * halfZ);
}

export class Director {
  private palette = new Palette('neon');
  private arc: Section[] = [];
  private sectionIndex = -1;
  private section: Section;

  /** Smoothed section energy, 0..1. */
  energy = 0.2;
  /** Camera shake amount the engine reads, 0..1. */
  shake = 0;
  /** Full-frame white flash for strobes, 0..1. */
  flash = 0;
  /** What the building is doing right now — set by the venue schedule. */
  venueMode: VenueMode = 'house';
  /** 0 = deep night, 1 = full daylight. Set by the time-of-day system. */
  dayness = 0;

  private look: LookName = 'ambient';
  private strobeLevel = 0;
  private blinderLevel = 0;
  private lasersOn = false;
  private t = 0;

  /** Set from the track's mood — see `applyMood`. */
  private mood: Mood = 'mid';
  private moodEnergy = 1;
  /** Multiplier on every movement speed: slow songs move slowly. */
  private pace = 1;
  private moodHaze = 1;

  // Scratch — the director runs every frame and must not allocate.
  private _p = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _aim = new THREE.Vector3();
  private _col = new THREE.Color();
  private _colB = new THREE.Color();
  private _black = new THREE.Color(0, 0, 0);

  constructor(
    private rig: Rig,
    private fx: Fx,
    private stage: Stage,
    private u: SharedUniforms,
    private clock: ShowClock,
    private events: DirectorEvents = {},
  ) {
    this.arc = resolveArc({ id: '', title: '', artist: '', bpm: 120, offset: 0, palette: 'neon' });
    this.section = this.arc[0];
  }

  setSong(song: Song) {
    this.applyMood(moodFor(song));
    this.palette.set(song.palette);
    this.arc = resolveArc(song);
    this.sectionIndex = -1;
    this.section = this.arc[0];
    this.look = this.section.look;
  }

  /**
   * A slow, sad track should not get a drop's worth of light. Mood scales the
   * ceiling on intensity, how fast fixtures travel, and how thick the air is.
   */
  private applyMood(mood: Mood) {
    this.mood = mood;
    if (mood === 'low') {
      this.moodEnergy = 0.5;
      this.pace = 0.42;
      this.moodHaze = 1.35;
    } else if (mood === 'high') {
      this.moodEnergy = 1.1;
      this.pace = 1.15;
      this.moodHaze = 0.95;
    } else {
      this.moodEnergy = 0.82;
      this.pace = 0.78;
      this.moodHaze = 1.1;
    }
  }

  get currentMood(): Mood {
    return this.mood;
  }

  /** Manual override — the HUD's lighting control. Sticks until the next song. */
  setMood(mood: Mood) {
    this.applyMood(mood);
  }

  setPalette(name: PaletteName) {
    this.palette.set(name);
  }

  get paletteName(): PaletteName {
    return this.palette.name;
  }

  /** Jump to a look immediately — used by the "cue" buttons in the HUD. */
  forceLook(look: LookName, energy = 0.8) {
    this.look = look;
    this.energy = energy;
  }

  update(dt: number, features?: AudioFeatures) {
    this.t += dt;
    const clock = this.clock;
    const bar = Math.max(0, clock.barIndex);

    // ---- section bookkeeping ------------------------------------------------
    if (this.venueMode === 'show') {
      this.advanceSection(bar);
    } else {
      this.section = this.venueMode === 'house' ? HOUSE_SECTION : CLOSED_SECTION;
      this.look = this.section.look;
      this.sectionIndex = -1;
    }

    this.runFrame(dt, features);
  }

  /** Cue-sheet advance, including the one-shot pyro/confetti triggers. */
  private advanceSection(bar: number) {
    const idx = sectionIndexAt(this.arc, bar);
    if (idx !== this.sectionIndex) {
      this.sectionIndex = idx;
      this.section = sectionAt(this.arc, bar);
      this.look = this.section.look;
      if (this.section.palette) this.palette.set(this.section.palette);
      if (this.section.confetti) this.fx.confetti();
      if (this.section.pyro) this.fx.pyro();
      this.events.onSection?.(this.section, idx);
    }
  }

  /** Everything that runs every frame, cue sheet or not. */
  private runFrame(dt: number, features?: AudioFeatures) {
    const clock = this.clock;
    const bar = Math.max(0, clock.barIndex);

    // ---- energy -------------------------------------------------------------
    const target = this.section.energy;
    // Builds ramp inside the section rather than sitting flat until the drop.
    const ramp =
      this.look === 'build'
        ? THREE.MathUtils.clamp((bar - this.section.bar) / 8, 0, 1) * 0.35
        : 0;
    this.energy += (target * this.moodEnergy + ramp - this.energy) * Math.min(1, dt * 2.2);

    let energy = this.energy;
    let bass = clock.pulse * energy;
    if (features && features.level > 0.001) {
      // Mic listening: let the room's actual dynamics push the show around,
      // without ever letting a quiet passage kill the cue sheet entirely.
      energy = THREE.MathUtils.clamp(energy * (0.55 + 0.75 * features.level), 0, 1.1);
      bass = Math.max(bass, features.bass);
    }

    // ---- shared uniforms ----------------------------------------------------
    const u = this.u;
    u.uTime.value = this.t;
    u.uBeat.value = clock.beats;
    u.uPulse.value = clock.pulse;
    u.uEnergy.value = energy;
    u.uBass.value = bass;

    // Daylight rewrites the whole design. Beams and haze stop existing, phone
    // torches disappear against the sky, and the video walls have to carry it.
    const day = THREE.MathUtils.clamp(this.dayness, 0, 1);
    const night = 1 - day;

    const phones = (this.section.phones ?? (this.look === 'ballad' ? 0.9 : 0.05)) * night;
    u.uPhones.value += (phones - u.uPhones.value) * Math.min(1, dt * 1.1);

    const hazeBase = this.look === 'ballad' || this.look === 'breakdown' ? 1.15 : 0.8 + energy * 0.35;
    const hazeTarget = hazeBase * this.moodHaze * (0.08 + 0.92 * night);
    u.uHaze.value += (hazeTarget - u.uHaze.value) * Math.min(1, dt * 1.5);

    this.rig.setBeamGain(0.1 + 0.9 * night);
    this.stage.setScreenBoost(1 + day * 1.9);

    // Accents drift through the palette on the phrase, not the beat — colour
    // changing every beat looks like a bug, not a design.
    this.palette.ramp((clock.phraseIndex * 0.31 + 0.05) % 1, this._col);
    this.palette.ramp((clock.phraseIndex * 0.31 + 0.42) % 1, this._colB);
    u.uAccentA.value.lerp(this._col, Math.min(1, dt * 2));
    u.uAccentB.value.lerp(this._colB, Math.min(1, dt * 2));

    // ---- the look ------------------------------------------------------------
    this.strobeLevel *= Math.max(0, 1 - dt * 26);
    this.blinderLevel *= Math.max(0, 1 - dt * 9);
    this.lasersOn = !!this.section.lasers;

    switch (this.look) {
      case 'blackout':
        this.doBlackout();
        break;
      case 'house':
        this.doHouse();
        break;
      case 'intro':
      case 'ambient':
        this.doAmbient(energy);
        break;
      case 'verse':
        this.doVerse(energy);
        break;
      case 'build':
        this.doBuild(energy, bar);
        break;
      case 'drop':
        this.doDrop(energy, bar);
        break;
      case 'chorus':
        this.doChorus(energy, bar);
        break;
      case 'breakdown':
        this.doBreakdown(energy);
        break;
      case 'ballad':
        this.doBallad(energy);
        break;
      case 'outro':
        this.doOutro(energy);
        break;
    }

    this.updateLasers(energy);

    this.rig.setBlinders(this.blinderLevel);
    this.rig.setStrobes(this.strobeLevel);
    this.rig.update(dt);
    this.stage.update(dt, clock.beats, energy);
    this.fx.update(dt, energy);

    this.flash = (this.strobeLevel * 0.16 + this.blinderLevel * 0.05) * night;
    this.shake =
      energy * (0.12 + 0.5 * clock.pulse) * (this.look === 'drop' ? 1 : 0.4) +
      (features ? features.bass * 0.25 : 0);
  }

  // -------------------------------------------------------------------------
  // Aim patterns
  // -------------------------------------------------------------------------

  /** Straight up, splayed into a fan. The signature "beam wall". */
  private aimPillars(list: Fixture[], spread: number, twist = 0) {
    for (const f of list) {
      const side = (f.t - 0.5) * 2;
      const ang = twist + side * spread;
      f.targetAim.set(
        f.position.x + Math.sin(ang) * 26,
        f.position.y + 80,
        f.position.z + Math.sin(ang * 1.7) * 14,
      );
    }
  }

  private aimFan(list: Fixture[], depth: number, spread: number, centre = 0) {
    for (const f of list) {
      audiencePoint(centre + (f.t - 0.5) * 2 * spread, depth, this._p);
      f.targetAim.copy(this._p);
    }
  }

  /** Whole group travels together across the crowd. */
  private aimSweep(list: Fixture[], speed: number, depth: number, width: number) {
    const c = Math.sin(this.clock.beats * speed * this.pace);
    for (const f of list) {
      audiencePoint(c + (f.t - 0.5) * width, depth, this._p);
      f.targetAim.copy(this._p);
    }
  }

  /** Alternate fixtures throw opposite ways, making a lattice of crossed beams. */
  private aimCross(list: Fixture[], depth: number, spread: number) {
    list.forEach((f, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      audiencePoint(side * spread * (0.35 + 0.65 * f.t), depth, this._p);
      f.targetAim.copy(this._p);
    });
  }

  /** Travelling wave down the truss. */
  private aimRipple(list: Fixture[], speed: number, depth: number, waves = 1.5) {
    const ph = this.clock.beats * speed * this.pace;
    for (const f of list) {
      const a = Math.sin(ph + f.t * Math.PI * 2 * waves);
      audiencePoint(a * 0.9, depth + a * 0.12, this._p);
      f.targetAim.copy(this._p);
    }
  }

  /** Lazy overlapping circles — the classic between-songs "ballyhoo". */
  private aimBallyhoo(list: Fixture[], speed: number) {
    const ph = this.t * speed * this.pace;
    for (const f of list) {
      const k = f.t * 6.283;
      audiencePoint(Math.sin(ph + k) * 1.1, 0.45 + 0.4 * Math.cos(ph * 0.73 + k), this._p);
      f.targetAim.copy(this._p);
    }
  }

  /** New position every `every` beats, held. Reads as hard, musical cutting. */
  private aimSnap(list: Fixture[], every: number, depth = 0.5) {
    const step = Math.floor(this.clock.beats / every);
    list.forEach((f, i) => {
      const a = hash2(step, i * 3.7) * 2 - 1;
      const d = depth + (hash2(step + 91, i * 1.3) - 0.5) * 0.5;
      audiencePoint(a * 1.15, d, this._p);
      f.targetAim.copy(this._p);
    });
  }

  private aimStage(list: Fixture[], alongThrust = false, zSpread = 0.75) {
    for (const f of list) {
      const z = (f.t - 0.5) * 2 * zSpread * (ARENA.stage.width / 2);
      const x = alongThrust
        ? THREE.MathUtils.lerp(STAGE_FRONT - 2, ARENA.stage.thrustTo, f.t)
        : ARENA.stage.cx + 4;
      f.targetAim.set(x, ARENA.stage.deckY + 0.3, alongThrust ? z * 0.2 : z);
    }
  }

  private aimAt(list: Fixture[], point: THREE.Vector3) {
    for (const f of list) f.targetAim.copy(point);
  }

  // -------------------------------------------------------------------------
  // Level + colour helpers
  // -------------------------------------------------------------------------

  private levels(
    list: Fixture[],
    level: number | ((f: Fixture, i: number) => number),
    colour: number | ((f: Fixture, i: number) => THREE.Color),
    spread?: number,
  ) {
    list.forEach((f, i) => {
      f.targetIntensity = typeof level === 'number' ? level : level(f, i);
      const c = typeof colour === 'number' ? this.palette.at(colour) : colour(f, i);
      f.targetColor.copy(c);
      if (spread !== undefined) f.spread = spread;
    });
  }

  private off(list: Fixture[]) {
    for (const f of list) f.targetIntensity = 0;
  }

  private get g() {
    return this.rig.groups;
  }

  // -------------------------------------------------------------------------
  // Looks
  // -------------------------------------------------------------------------

  private doBlackout() {
    for (const f of this.rig.fixtures) f.targetIntensity = 0;
    this.stage.setScreenMode(SCREEN.PLASMA);
  }

  /**
   * Working light. Broad, plain, slightly warm, aimed flat at the seating
   * bowl — the opposite of a show look. Nothing moves, because nothing should.
   */
  private doHouse() {
    const g = this.g;
    const white = () => this._col.setRGB(1, 0.96, 0.88);

    this.aimFan(g.houseA, 0.3, 1.25);
    this.aimFan(g.houseB, 0.58, 1.25);
    this.aimFan(g.houseC, 0.86, 1.25);
    this.levels([...g.houseA, ...g.houseB, ...g.houseC], 0.5, white, 4.2);

    this.aimStage(g.frontTruss, false, 0.95);
    this.levels(g.frontTruss, 0.28, white, 3.4);

    this.off(g.backTruss);
    this.off(g.floor);
    this.off([...g.sideL, ...g.sideR]);

    this.stage.setScreenMode(SCREEN.MARQUEE);
  }

  private doAmbient(energy: number) {
    const g = this.g;
    this.aimPillars(g.backTruss, 0.22, Math.sin(this.t * 0.18) * 0.25);
    this.levels(g.backTruss, 0.16 + 0.2 * energy, 0, 2.6);

    this.aimStage(g.frontTruss, true);
    this.levels(g.frontTruss, 0.22 + 0.25 * energy, () => this._col.setRGB(1, 0.85, 0.66), 2.6);

    this.aimBallyhoo(g.houseA, 0.11);
    this.aimBallyhoo(g.houseB, 0.09);
    this.levels([...g.houseA, ...g.houseB], 0.07 * energy, 2, 3.0);
    this.off(g.houseC);

    this.aimPillars(g.floor, 0.3);
    this.levels(g.floor, 0.2 * energy, 1, 2.2);
    this.off([...g.sideL, ...g.sideR]);

    this.stage.setScreenMode(SCREEN.PLASMA);
  }

  private doVerse(energy: number) {
    const g = this.g;
    // Key light on the vocalist, everything else supporting.
    this.aimAt(g.frontTruss.slice(4, 8), STAGE_FOCUS);
    this.aimStage(g.frontTruss.slice(0, 4), false);
    this.aimStage(g.frontTruss.slice(8), false);
    this.levels(g.frontTruss, 0.42 + 0.3 * energy, () => this._col.setRGB(1, 0.9, 0.76), 2.4);

    this.aimCross(g.backTruss, 0.62, 1.0);
    this.levels(g.backTruss, (f) => (0.2 + 0.4 * energy) * (0.7 + 0.3 * f.t), 0, 2.0);

    this.aimSweep(g.sideL, 0.24, 0.35, 0.5);
    this.aimSweep(g.sideR, -0.24, 0.35, 0.5);
    this.levels([...g.sideL, ...g.sideR], 0.22 * energy, 3, 2.2);

    this.aimRipple(g.houseA, 0.3, 0.3);
    this.aimRipple(g.houseB, 0.3, 0.55);
    this.levels([...g.houseA, ...g.houseB], 0.16 * energy, 1, 2.8);
    this.off(g.houseC);
    this.off(g.floor);

    this.stage.setScreenMode(SCREEN.SCAN);
  }

  private doBuild(energy: number, bar: number) {
    const g = this.g;
    const clock = this.clock;
    const progress = THREE.MathUtils.clamp((bar - this.section.bar) / 8, 0, 1);

    // Beams converge as the build tightens: the visual equivalent of a riser.
    this.aimPillars(g.backTruss, 0.5 - progress * 0.42, Math.sin(this.t * 0.6) * 0.15);
    this.levels(g.backTruss, 0.3 + 0.6 * progress, 0, 2.4 - progress * 0.9);

    this.aimFan(g.frontTruss, 0.25 + progress * 0.5, 0.9);
    this.levels(g.frontTruss, 0.25 + 0.4 * progress, 4, 2.2);

    this.aimRipple(g.houseA, 0.8 + progress * 2, 0.25);
    this.aimRipple(g.houseB, 0.8 + progress * 2, 0.5);
    this.aimRipple(g.houseC, 0.8 + progress * 2, 0.8);
    this.levels([...g.houseA, ...g.houseB, ...g.houseC], 0.2 + 0.5 * progress, 2, 2.6);

    this.aimPillars(g.floor, 0.16);
    this.levels(g.floor, 0.3 + 0.5 * progress, 1, 1.9);
    this.aimCross([...g.sideL, ...g.sideR], 0.5, 1.1);
    this.levels([...g.sideL, ...g.sideR], 0.3 + 0.4 * progress, 3, 2.0);

    // Blinders pulse faster and faster; strobe kicks in for the last two bars.
    const div = progress > 0.75 ? 4 : progress > 0.45 ? 2 : 1;
    const sub = (clock.beats * div) % 1;
    this.blinderLevel = Math.max(this.blinderLevel, Math.pow(1 - sub, 2.5) * progress * 0.75);
    if (this.section.strobe && progress > 0.8) {
      this.strobeLevel = Math.max(this.strobeLevel, (clock.beats * 8) % 1 < 0.5 ? 0.7 : 0);
    }

    this.stage.setScreenMode(SCREEN.BARS);
  }

  private doDrop(energy: number, bar: number) {
    const g = this.g;
    const clock = this.clock;
    const beatsIn = clock.beats - this.section.bar * 4;

    // Tight beam wall snapping to a new position every beat.
    this.aimSnap(g.backTruss, 1, 0.55);
    this.levels(
      g.backTruss,
      () => 0.55 + 0.65 * clock.pulse * energy,
      (f, i) => this.palette.at(clock.barIndex + (i % 2) * 2),
      1.45,
    );

    // Straight into the crowd — this is what you feel from a seat.
    this.aimCross(g.frontTruss, 0.42, 1.25);
    this.levels(g.frontTruss, () => 0.5 + 0.5 * clock.pulse, 1, 2.0);

    this.aimSnap(g.houseA, 1, 0.28);
    this.aimSnap(g.houseB, 1, 0.55);
    this.aimSnap(g.houseC, 1, 0.85);
    this.levels(
      [...g.houseA, ...g.houseB, ...g.houseC],
      () => 0.45 + 0.55 * clock.pulse,
      (f, i) => this.palette.at(clock.barIndex + 1 + (i % 3)),
      2.2,
    );

    this.aimPillars(g.floor, 0.1);
    this.levels(g.floor, 0.75 + 0.35 * clock.pulse, 4, 1.5);

    this.aimSweep(g.sideL, 1.1, 0.4, 0.6);
    this.aimSweep(g.sideR, -1.1, 0.4, 0.6);
    this.levels([...g.sideL, ...g.sideR], 0.55 + 0.4 * clock.pulse, 3, 1.8);

    this.blinderLevel = Math.max(this.blinderLevel, Math.pow(clock.pulse, 1.6) * 0.95);
    // Strobe only for the first bar of the drop, on 8ths. Any longer and it
    // stops being an accent and starts being an assault.
    if (beatsIn < 4) {
      this.strobeLevel = Math.max(this.strobeLevel, (clock.beats * 8) % 1 < 0.4 ? 0.9 : 0);
    }

    this.stage.setScreenMode(clock.barIndex % 4 === 3 ? SCREEN.FLASH : SCREEN.BARS);
  }

  private doChorus(energy: number, bar: number) {
    const g = this.g;
    const clock = this.clock;

    this.aimPillars(g.backTruss, 0.34, Math.sin(this.t * 0.5) * 0.3);
    this.levels(g.backTruss, 0.45 + 0.35 * clock.pulse * energy, clock.barIndex, 1.8);

    this.aimAt(g.frontTruss.slice(4, 8), STAGE_FOCUS);
    this.aimSweep(g.frontTruss.slice(0, 4), 0.5, 0.55, 0.7);
    this.aimSweep(g.frontTruss.slice(8), -0.5, 0.55, 0.7);
    this.levels(g.frontTruss, 0.5 + 0.3 * energy, () => this._col.setRGB(1, 0.92, 0.8), 2.2);

    this.aimRipple(g.houseA, 0.55, 0.3, 1);
    this.aimRipple(g.houseB, 0.55, 0.55, 1.5);
    this.aimRipple(g.houseC, 0.55, 0.85, 2);
    this.levels(
      [...g.houseA, ...g.houseB, ...g.houseC],
      0.4 + 0.35 * energy,
      (f, i) => this.palette.at(clock.barIndex + (i % 2)),
      2.4,
    );

    this.aimPillars(g.floor, 0.22);
    this.levels(g.floor, 0.5 + 0.3 * clock.pulse, 4, 1.7);
    this.aimCross([...g.sideL, ...g.sideR], 0.55, 1.1);
    this.levels([...g.sideL, ...g.sideR], 0.4, 3, 2.0);

    this.blinderLevel = Math.max(this.blinderLevel, clock.barPhase < 0.06 ? 0.5 : 0);
    this.stage.setScreenMode(SCREEN.BARS);
  }

  private doBreakdown(energy: number) {
    const g = this.g;
    this.off(g.backTruss);
    this.off([...g.houseB, ...g.houseC]);

    this.aimAt(g.frontTruss.slice(5, 7), STAGE_FOCUS);
    this.levels(g.frontTruss, (f, i) => (i >= 5 && i < 7 ? 0.55 : 0.05), () => this._col.setRGB(1, 0.93, 0.82), 2.0);

    this.aimPillars(g.floor, 0.36, Math.sin(this.t * 0.22) * 0.4);
    this.levels(g.floor, 0.35 + 0.2 * energy, 2, 2.4);

    this.aimBallyhoo(g.houseA, 0.07);
    this.levels(g.houseA, 0.1, 1, 3.2);
    this.aimSweep(g.sideL, 0.12, 0.3, 0.4);
    this.aimSweep(g.sideR, -0.12, 0.3, 0.4);
    this.levels([...g.sideL, ...g.sideR], 0.14, 3, 2.6);

    this.stage.setScreenMode(SCREEN.PLASMA);
  }

  private doBallad(energy: number) {
    const g = this.g;
    this.off(g.backTruss);
    this.off([...g.houseA, ...g.houseB, ...g.houseC]);

    // One warm key on the vocal, a soft wash behind, and 60,000 phone torches
    // doing the rest of the work.
    this.aimAt(g.frontTruss.slice(5, 7), STAGE_FOCUS);
    this.levels(
      g.frontTruss,
      (f, i) => (i >= 5 && i < 7 ? 0.6 : 0.04),
      () => this._col.setRGB(1, 0.9, 0.74),
      1.9,
    );

    this.aimPillars(g.floor, 0.42, Math.sin(this.t * 0.15) * 0.3);
    this.levels(g.floor, 0.22, 2, 2.8);
    this.aimStage([...g.sideL, ...g.sideR], false, 0.9);
    this.levels([...g.sideL, ...g.sideR], 0.16, 3, 2.4);

    this.stage.setScreenMode(SCREEN.PLASMA);
  }

  private doOutro(energy: number) {
    const g = this.g;
    this.aimBallyhoo(g.backTruss, 0.16);
    this.levels(g.backTruss, 0.22 + 0.2 * energy, 0, 2.4);
    this.aimStage(g.frontTruss, true);
    this.levels(g.frontTruss, 0.35, () => this._col.setRGB(1, 0.88, 0.72), 2.4);
    this.aimBallyhoo(g.houseA, 0.12);
    this.aimBallyhoo(g.houseB, 0.1);
    this.levels([...g.houseA, ...g.houseB], 0.18 * energy, 2, 3.0);
    this.off(g.houseC);
    this.aimPillars(g.floor, 0.34);
    this.levels(g.floor, 0.28, 1, 2.4);
    this.off([...g.sideL, ...g.sideR]);
    this.stage.setScreenMode(SCREEN.MARQUEE);
  }

  // -------------------------------------------------------------------------
  // Lasers
  // -------------------------------------------------------------------------

  private updateLasers(energy: number) {
    const rig = this.rig;
    const per = Math.max(1, Math.floor(rig.laserCount / rig.laserOrigins.length));

    if (!this.lasersOn) {
      for (let i = 0; i < rig.laserCount; i++) rig.setLaser(i, this._aim, this._black, 0);
      return;
    }

    const beats = this.clock.beats;
    for (let j = 0; j < rig.laserOrigins.length; j++) {
      const origin = rig.laserOrigins[j];
      const sweep = Math.sin(beats * 0.55 + j * 2.1) * 0.6;
      const colour = this.palette.at(j + Math.floor(beats / 8));
      for (let k = 0; k < per; k++) {
        const across = per > 1 ? (k / (per - 1) - 0.5) * 2 : 0;
        const yaw = sweep + across * 0.5;
        const pitch = 0.16 + 0.18 * Math.sin(beats * 1.3 + j * 1.7) + across * 0.04;
        this._dir.set(Math.cos(yaw), Math.sin(pitch), Math.sin(yaw)).normalize();
        this._aim.copy(origin).addScaledVector(this._dir, 170);
        // Chase pattern: a third of the fan is dimmed at any moment, which is
        // what makes a laser fan look like it's moving rather than glowing.
        const chase = (Math.floor(beats * 4) + k) % 3 === 0 ? 0.25 : 1;
        rig.setLaser(j * per + k, this._aim, colour, 0.5 * energy * chase);
      }
    }
  }

  get currentSection(): Section {
    return this.section;
  }
  get currentLook(): LookName {
    return this.look;
  }
}
