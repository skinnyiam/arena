import * as THREE from 'three';

/**
 * The venue's day.
 *
 * A real stadium isn't a permanent concert — it's closed, then doors open into
 * an empty daylit bowl, then it fills, a support act plays, there's a
 * changeover, and the headliner walks out after dark. Modelling that as a
 * schedule rather than an always-on show is what makes the place feel like it
 * exists when you're not looking at it.
 */
export type VenuePhase =
  | 'closed'
  | 'doors'
  | 'filling'
  | 'support'
  | 'interval'
  | 'headliner'
  | 'encore'
  | 'egress';

export type SetSlot = 'none' | 'support' | 'headliner';

export type ShowSlot = {
  /** Hour of the day this phase begins, 0-24. */
  at: number;
  phase: VenuePhase;
  label: string;
  /** Detail line for the HUD. */
  detail: string;
  /** Target crowd occupancy, 0..1 — interpolated toward the next slot. */
  occupancy: number;
  set: SetSlot;
};

export const DAY_SCHEDULE: ShowSlot[] = [
  { at: 0, phase: 'closed', label: 'Venue closed', detail: 'Dark until doors', occupancy: 0, set: 'none' },
  { at: 15.5, phase: 'doors', label: 'Doors open', detail: 'Gates A–H now admitting', occupancy: 0.05, set: 'none' },
  { at: 16.5, phase: 'filling', label: 'Crowd arriving', detail: 'House music · concourse open', occupancy: 0.4, set: 'none' },
  { at: 18, phase: 'support', label: 'Support act', detail: 'Opening set', occupancy: 0.66, set: 'support' },
  { at: 19.2, phase: 'interval', label: 'Changeover', detail: 'Stage reset · 30 minutes', occupancy: 0.85, set: 'none' },
  { at: 20.5, phase: 'headliner', label: 'Headline set', detail: 'Main event', occupancy: 1, set: 'headliner' },
  { at: 22.3, phase: 'encore', label: 'Encore', detail: 'Two more', occupancy: 0.96, set: 'headliner' },
  { at: 22.9, phase: 'egress', label: 'Show over', detail: 'Crowd leaving', occupancy: 0.3, set: 'none' },
  { at: 23.8, phase: 'closed', label: 'Venue closed', detail: 'Load-out', occupancy: 0, set: 'none' },
];

/** Named times you can jump to, for scrubbing the day. */
export const TIME_PRESETS: Array<{ label: string; hour: number }> = [
  { label: 'Sunrise', hour: 6.6 },
  { label: 'Noon', hour: 12.5 },
  { label: 'Doors', hour: 15.7 },
  { label: 'Golden', hour: 18.4 },
  { label: 'Showtime', hour: 20.6 },
  { label: 'Encore', hour: 22.4 },
];

function slotIndexAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  let idx = 0;
  for (let i = 0; i < DAY_SCHEDULE.length; i++) {
    if (DAY_SCHEDULE[i].at <= h) idx = i;
    else break;
  }
  return idx;
}

export class VenueClock {
  /** Hour of the venue's day, 0-24. */
  hour: number;
  /** Sim hours per real second. 1/3600 is wall-clock speed. */
  timeScale = 1 / 3600;
  running = true;

  private index = -1;
  onPhaseChange?: (slot: ShowSlot, index: number) => void;

  constructor(startHour = 20.6) {
    this.hour = startHour;
  }

  update(dt: number) {
    if (this.running) {
      this.hour = (this.hour + dt * this.timeScale) % 24;
    }
    const idx = slotIndexAt(this.hour);
    if (idx !== this.index) {
      this.index = idx;
      this.onPhaseChange?.(DAY_SCHEDULE[idx], idx);
    }
  }

  setHour(hour: number) {
    this.hour = ((hour % 24) + 24) % 24;
    // Re-evaluate immediately so a scrub fires the phase change this frame.
    const idx = slotIndexAt(this.hour);
    if (idx !== this.index) {
      this.index = idx;
      this.onPhaseChange?.(DAY_SCHEDULE[idx], idx);
    }
  }

  get slot(): ShowSlot {
    return DAY_SCHEDULE[Math.max(0, this.index)];
  }

  get nextSlot(): ShowSlot {
    return DAY_SCHEDULE[(Math.max(0, this.index) + 1) % DAY_SCHEDULE.length];
  }

  /**
   * Crowd occupancy right now, eased between the current and next slot so the
   * bowl fills and empties gradually rather than popping.
   */
  get occupancy(): number {
    const a = this.slot;
    const b = this.nextSlot;
    const span = (b.at <= a.at ? b.at + 24 : b.at) - a.at;
    const k = THREE.MathUtils.clamp((this.hour - a.at) / Math.max(1e-6, span), 0, 1);
    // Ease-out: people arrive fast when a phase starts, then it plateaus.
    return THREE.MathUtils.lerp(a.occupancy, b.occupancy, 1 - Math.pow(1 - k, 2));
  }

  /** Minutes of venue time until the next phase. */
  get minutesToNext(): number {
    const b = this.nextSlot;
    let delta = b.at - this.hour;
    if (delta < 0) delta += 24;
    return Math.round(delta * 60);
  }

  get clockText(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
