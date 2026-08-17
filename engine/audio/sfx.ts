/**
 * Synthesised sound effects.
 *
 * There are no audio files in this project and none are needed for these —
 * footsteps and crowd murmur are both filtered noise, which Web Audio can
 * generate far more cheaply than a download. It also sidesteps the licensing
 * question entirely.
 *
 * Note this graph is completely separate from the music: the track plays in a
 * cross-origin YouTube iframe whose samples never reach Web Audio, so these
 * effects can't be ducked against it or spatialised relative to it. They're
 * mixed by level alone.
 */

export type Surface = 'pavement' | 'concrete' | 'grass';

const SURFACE: Record<Surface, { freq: number; q: number; decay: number; gain: number }> = {
  pavement: { freq: 1500, q: 1.1, decay: 0.075, gain: 0.5 },
  concrete: { freq: 1900, q: 1.4, decay: 0.06, gain: 0.55 },
  grass: { freq: 720, q: 0.8, decay: 0.11, gain: 0.34 },
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  private murmurSrc: AudioBufferSourceNode | null = null;
  private murmurGain: GainNode | null = null;

  enabled = true;
  private volume = 0.6;

  /**
   * Must be called from a user gesture — browsers refuse to start an
   * AudioContext otherwise, and a suspended context fails silently.
   */
  async resume(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise(this.ctx, 1);
      this.startMurmur();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private makeNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Brownian rather than white: much closer to the spectrum of real
    // footfalls and crowd noise, both of which are heavily low-weighted.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    return buf;
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** One footfall. */
  step(surface: Surface = 'pavement', intensity = 1) {
    if (!this.enabled || !this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;
    const cfg = SURFACE[surface];
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    // Random start point, so no two steps are the same sample.
    const offset = Math.random() * 0.8;

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    // Heel and toe land slightly differently; vary the centre frequency.
    band.frequency.value = cfg.freq * (0.85 + Math.random() * 0.3);
    band.Q.value = cfg.q;

    const gain = ctx.createGain();
    const peak = cfg.gain * intensity * (0.8 + Math.random() * 0.4);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + cfg.decay);

    src.connect(band).connect(gain).connect(this.master);
    src.start(now, offset, cfg.decay + 0.02);
    src.stop(now + cfg.decay + 0.05);
  }

  /** Continuous crowd murmur; `level` 0..1 follows how many people are near. */
  setMurmur(level: number) {
    if (!this.murmurGain || !this.ctx) return;
    const target = Math.max(0, Math.min(1, level)) * 0.14;
    this.murmurGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6);
  }

  private startMurmur() {
    if (!this.ctx || !this.master || !this.noise) return;
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    // Two stacked filters approximate the formant hump of massed voices.
    const low = ctx.createBiquadFilter();
    low.type = 'bandpass';
    low.frequency.value = 480;
    low.Q.value = 0.7;

    const high = ctx.createBiquadFilter();
    high.type = 'peaking';
    high.frequency.value = 1600;
    high.Q.value = 0.9;
    high.gain.value = 5;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    // Slow wobble, so it breathes instead of sitting as flat hiss.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(low.frequency);
    lfo.start();

    src.connect(low).connect(high).connect(gain).connect(this.master);
    src.start();

    this.murmurSrc = src;
    this.murmurGain = gain;
  }

  dispose() {
    try {
      this.murmurSrc?.stop();
    } catch {
      /* already stopped */
    }
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.murmurGain = null;
    this.murmurSrc = null;
  }
}
