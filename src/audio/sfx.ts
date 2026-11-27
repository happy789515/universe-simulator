const MASTER_GAIN = 0.42;
const DESTROY_COALESCE_MS = 60;

export class ProceduralSfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastDestroyAt = 0;
  private warned = false;

  prime(): void {
    this.running();
  }

  playSelect(): void {
    const ctx = this.running();
    if (!ctx) return;
    this.tone(ctx, "sine", 660, 1320, 0.16, 0.01, 0.09);
  }

  playImpact(): void {
    const ctx = this.running();
    if (!ctx) return;
    this.noiseBurst(ctx, "bandpass", 2200, 240, 0.85, 0.4, 0.006, 0.24);
    this.tone(ctx, "sine", 130, 48, 0.46, 0.008, 0.2);
  }

  playDestroy(): void {
    const now = performance.now();
    if (now - this.lastDestroyAt < DESTROY_COALESCE_MS) return;
    const ctx = this.running();
    if (!ctx) return;
    this.lastDestroyAt = now;
    this.noiseBurst(ctx, "lowpass", 780, 60, 0.7, 0.32, 0.025, 0.55);
    this.tone(ctx, "triangle", 170, 34, 0.38, 0.03, 0.52);
  }

  private running(): AudioContext | null {
    const ctx = this.ensure();
    if (!ctx) return null;
    if (ctx.state === "suspended") {
      void ctx.resume().catch((err: unknown) => {
        this.warnOnce(err);
      });
    }
    return ctx;
  }

  private ensure(): AudioContext | null {
    if (this.ctx && this.master) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -16;
      compressor.knee.value = 10;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.18;
      master.connect(compressor);
      compressor.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch (err: unknown) {
      this.warnOnce(err);
      return null;
    }
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("Web Audio unavailable", err);
  }

  private envelope(
    ctx: AudioContext,
    peak: number,
    attack: number,
    release: number,
  ): GainNode {
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    const safePeak = Math.max(peak, 0.0002);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(safePeak, t + Math.max(attack, 0.001));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    gain.connect(this.master!);
    return gain;
  }

  private tone(
    ctx: AudioContext,
    type: OscillatorType,
    freqStart: number,
    freqEnd: number,
    peak: number,
    attack: number,
    release: number,
  ): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = this.envelope(ctx, peak, attack, release);
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, t + attack + release);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + attack + release + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  private noiseBurst(
    ctx: AudioContext,
    filterType: BiquadFilterType,
    freqStart: number,
    freqEnd: number,
    q: number,
    peak: number,
    attack: number,
    release: number,
  ): void {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = this.envelope(ctx, peak, attack, release);
    src.buffer = this.noiseBuffer(ctx);
    filter.type = filterType;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freqStart, t);
    filter.frequency.exponentialRampToValueAtTime(
      freqEnd,
      t + attack + release,
    );
    src.connect(filter);
    filter.connect(gain);
    src.start(t);
    src.stop(t + attack + release + 0.02);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise && this.noise.sampleRate === ctx.sampleRate) return this.noise;
    const length = Math.floor(ctx.sampleRate);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }
}

export const sfx = new ProceduralSfx();
