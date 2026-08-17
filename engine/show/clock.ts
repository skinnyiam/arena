/**
 * The musical clock.
 *
 * A YouTube iframe will not hand us its audio buffer, so we cannot FFT the
 * track. What we *can* read is `getCurrentTime()` — but only at ~4Hz, in coarse
 * steps. Driving lights straight off that polled value produces visible
 * stair-stepping.
 *
 * So this clock free-runs at frame rate and treats the player's time as a drift
 * correction: small errors nudge the playback rate (a phase-locked loop), large
 * ones snap. Everything downstream reads a smooth, sub-frame-accurate beat.
 */
export class ShowClock {
  /** Smoothed playback position, seconds. */
  time = 0;
  playing = false;

  bpm = 120;
  /** Seconds from t=0 to the first downbeat. */
  offset = 0;

  /** Fractional beats since the downbeat. */
  beats = 0;
  /** 0..1 position inside the current beat. */
  beatPhase = 0;
  /** 0..1 position inside the current bar. */
  barPhase = 0;
  /** Sharp attack on each beat, decaying to 0 — the workhorse for light hits. */
  pulse = 0;

  beatIndex = -1;
  barIndex = -1;
  phraseIndex = -1;

  onBeat = false;
  onHalfBeat = false;
  onBar = false;
  /** Every 8 bars — where real light shows change look. */
  onPhrase = false;

  private rate = 1;
  private halfIndex = -1;
  private lastExternal = -1;

  setTempo(bpm: number, offset: number) {
    this.bpm = Math.max(40, Math.min(220, bpm));
    this.offset = offset;
  }

  /** Jump the clock, e.g. after a seek or a track change. */
  reset(time = 0) {
    this.time = time;
    this.rate = 1;
    this.lastExternal = -1;
    this.beatIndex = this.barIndex = this.phraseIndex = this.halfIndex = -1;
  }

  /** Feed a freshly polled player time. Safe to call at any rate, or never. */
  syncExternal(t: number) {
    if (!Number.isFinite(t) || t < 0) return;
    if (t === this.lastExternal) return; // player hasn't ticked yet
    this.lastExternal = t;

    const err = t - this.time;
    if (Math.abs(err) > 0.4) {
      // Seek, stall, or first sync: hard snap.
      this.time = t;
      this.rate = 1;
      return;
    }
    // Gentle rate trim. Bounded so a hiccup can never visibly speed the show up.
    this.rate = 1 + Math.max(-0.08, Math.min(0.08, err * 0.5));
  }

  update(dt: number) {
    if (this.playing) this.time += dt * this.rate;

    const b = Math.max(0, this.time - this.offset) * (this.bpm / 60);
    this.beats = b;

    const beat = Math.floor(b);
    this.onBeat = beat !== this.beatIndex;
    this.beatIndex = beat;

    const half = Math.floor(b * 2);
    this.onHalfBeat = half !== this.halfIndex;
    this.halfIndex = half;

    const bar = Math.floor(b / 4);
    this.onBar = bar !== this.barIndex;
    this.barIndex = bar;

    const phrase = Math.floor(b / 32);
    this.onPhrase = phrase !== this.phraseIndex;
    this.phraseIndex = phrase;

    this.beatPhase = b - beat;
    this.barPhase = (b / 4) % 1;
    // Percussive envelope: instant attack, fast decay.
    this.pulse = Math.pow(1 - this.beatPhase, 3.2);
  }

  get bars() {
    return this.beats / 4;
  }
  get secondsPerBeat() {
    return 60 / this.bpm;
  }
}

/**
 * Tap-tempo estimator. Averages the last few intervals and discards outliers,
 * so one clumsy tap doesn't wreck the estimate.
 */
export class TapTempo {
  private taps: number[] = [];

  /** @param now performance.now() in ms. Returns a BPM once 2+ taps are in. */
  tap(now: number): number | null {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) {
      this.taps = []; // long pause: start a new count-in
    }
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 2) return null;

    const gaps: number[] = [];
    for (let i = 1; i < this.taps.length; i++) gaps.push(this.taps[i] - this.taps[i - 1]);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const kept = gaps.filter((g) => Math.abs(g - median) < median * 0.35);
    const avg = kept.reduce((a, b) => a + b, 0) / Math.max(1, kept.length);

    let bpm = 60000 / avg;
    while (bpm < 70) bpm *= 2; // taps on half-time
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm * 10) / 10;
  }

  clear() {
    this.taps = [];
  }
}
