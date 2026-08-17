/**
 * Optional microphone analyser — the one honest way to get *real* reactivity
 * out of a cross-origin YouTube stream: listen to the room.
 *
 * With speakers on, the mic hears the track and the show responds to the actual
 * mix rather than to a BPM estimate. With headphones on it hears nothing, which
 * is why the beat clock remains the primary driver and this is only ever a
 * modulation layer blended on top.
 */
export type AudioFeatures = {
  /** 0..1, auto-gained. */
  level: number;
  bass: number;
  mid: number;
  high: number;
  /** Spectral-flux onset, decays quickly. */
  onset: number;
};

export class MicAnalyser {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private prev: Float32Array | null = null;

  active = false;
  features: AudioFeatures = { level: 0, bass: 0, mid: 0, high: 0, onset: 0 };

  /** Running peak for auto-gain, so quiet laptop speakers still drive a show. */
  private peak = 0.08;
  private onsetEnv = 0;

  async start(): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser exposes no microphone API.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, // we *want* to hear the speakers
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    await this.ctx.resume();

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.55;
    src.connect(this.analyser);

    this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.prev = new Float32Array(this.analyser.frequencyBinCount);
    this.active = true;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this.active = false;
    this.features = { level: 0, bass: 0, mid: 0, high: 0, onset: 0 };
  }

  update(dt: number) {
    const a = this.analyser;
    const freq = this.freq;
    const prev = this.prev;
    if (!a || !freq || !prev || !this.ctx) return;

    a.getByteFrequencyData(freq);

    const nyquist = this.ctx.sampleRate / 2;
    const binHz = nyquist / freq.length;
    const bandEnergy = (loHz: number, hiHz: number) => {
      const lo = Math.max(0, Math.floor(loHz / binHz));
      const hi = Math.min(freq.length - 1, Math.ceil(hiHz / binHz));
      let sum = 0;
      for (let i = lo; i <= hi; i++) sum += freq[i];
      return sum / ((hi - lo + 1) * 255);
    };

    const bass = bandEnergy(35, 170);
    const mid = bandEnergy(170, 2000);
    const high = bandEnergy(2000, 9000);
    const level = bass * 0.5 + mid * 0.35 + high * 0.15;

    // Spectral flux: only rises count, which is what an onset is.
    let flux = 0;
    for (let i = 0; i < freq.length; i++) {
      const v = freq[i] / 255;
      const d = v - prev[i];
      if (d > 0) flux += d;
      prev[i] = v;
    }
    flux /= freq.length;

    // Auto-gain: track the peak, bleed it down so the show doesn't stay
    // desensitised after one loud moment.
    this.peak = Math.max(this.peak * (1 - dt * 0.25), level, 0.04);
    const gain = 1 / this.peak;

    this.onsetEnv = Math.max(this.onsetEnv - dt * 5, Math.min(1, flux * 18));

    const f = this.features;
    const k = Math.min(1, dt * 14); // smoothing toward the new reading
    f.level += (Math.min(1, level * gain) - f.level) * k;
    f.bass += (Math.min(1, bass * gain * 1.15) - f.bass) * k;
    f.mid += (Math.min(1, mid * gain) - f.mid) * k;
    f.high += (Math.min(1, high * gain) - f.high) * k;
    f.onset = this.onsetEnv;
  }
}
