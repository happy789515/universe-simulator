const LEVEL = 0.34;
const SILENT = 0.0001;
const FADE_IN_SEC = 2.6;
const FADE_OUT_SEC = 0.45;

/** A minor pentatonic. Sparse, slow, and consonant with the drone. */
const STAR_HZ = [220, 261.63, 293.66, 329.63, 392, 440];

/**
 * Original procedural bed: detuned low sines, filtered noise, rare soft tones.
 * No samples and no recorded music. The context is created on the first gesture.
 */
export class AmbientMusic {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private started = false;
  private muted = false;
  private bound = false;
  private warned = false;
  private gestureLock = false;

  /** First loading-screen click or later pointer. The mute control is ignored here. */
  bindGesture(boot: HTMLElement): void {
    if (this.bound) return;
    this.bound = true;
    boot.addEventListener("pointerdown", this.onPointer);
    window.addEventListener("pointerdown", this.onPointer, true);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Click handler for the mute control. Returns the new muted state. */
  toggleMuted(): boolean {
    this.muted = !this.muted;
    if (this.muted) this.fadeTo(SILENT, FADE_OUT_SEC);
    else this.unlock();
    return this.muted;
  }

  private onPointer = (event: Event): void => {
    if (this.gestureLock) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-music-toggle]")) return;
    if (this.muted) return;
    if (this.started && this.ctx?.state === "running") return;
    this.gestureLock = true;
    queueMicrotask(() => {
      this.gestureLock = false;
    });
    this.unlock();
  };

  private unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().catch((err: unknown) => {
        this.warnOnce(err);
      });
    }
    if (!this.started) {
      this.started = true;
      this.build(ctx);
      this.queuePulse();
    }
    if (!this.muted) this.fadeTo(LEVEL, this.master!.gain.value > 0.02 ? 0.8 : FADE_IN_SEC);
  }

  private ensure(): AudioContext | null {
    if (this.ctx && this.master) return this.ctx;
    const Ctor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = SILENT;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch (err: unknown) {
      this.warnOnce(err);
      return null;
    }
  }

  private build(ctx: AudioContext): void {
    const master = this.master;
    if (!master) return;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 240;
    lowpass.Q.value = 0.65;
    lowpass.connect(master);

    const filterLfo = ctx.createOscillator();
    const filterDepth = ctx.createGain();
    filterLfo.frequency.value = 0.02;
    filterDepth.gain.value = 70;
    filterLfo.connect(filterDepth);
    filterDepth.connect(lowpass.frequency);
    filterLfo.start();

    this.tone(ctx, lowpass, 55, 0, 0.16, 0.013, 5);
    this.tone(ctx, lowpass, 55, 8, 0.12, 0.019, 4);
    this.tone(ctx, lowpass, 82.41, 0, 0.07, 0.011, 6);
    this.tone(ctx, lowpass, 130.81, 0, 0.04, 0.017, 7);

    const air = ctx.createBufferSource();
    air.buffer = this.airBuffer(ctx);
    air.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 480;
    band.Q.value = 0.45;
    const airGain = ctx.createGain();
    airGain.gain.value = 0.02;
    const airLfo = ctx.createOscillator();
    const airDepth = ctx.createGain();
    airLfo.frequency.value = 0.035;
    airDepth.gain.value = 0.008;
    airLfo.connect(airDepth);
    airDepth.connect(airGain.gain);
    air.connect(band);
    band.connect(airGain);
    airGain.connect(master);
    air.start();
    airLfo.start();
  }

  private tone(
    ctx: AudioContext,
    dest: AudioNode,
    freq: number,
    detuneCents: number,
    level: number,
    lfoHz: number,
    lfoCents: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.detune.value = detuneCents;
    gain.gain.value = level;
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = lfoHz;
    depth.gain.value = lfoCents;
    lfo.connect(depth);
    depth.connect(osc.detune);
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    lfo.start();
  }

  private queuePulse(): void {
    const wait = 14000 + Math.random() * 10000;
    window.setTimeout(() => {
      this.pulse();
      this.queuePulse();
    }, wait);
  }

  private pulse(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted || ctx.state !== "running") return;
    const freq = STAR_HZ[Math.floor(Math.random() * STAR_HZ.length)];
    const t = ctx.currentTime + 0.05;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(SILENT, t);
    gain.gain.exponentialRampToValueAtTime(0.016, t + 2.4);
    gain.gain.exponentialRampToValueAtTime(SILENT, t + 9);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + 9.05);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  private fadeTo(target: number, seconds: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const gain = master.gain;
    const now = ctx.currentTime;
    const safeTarget = Math.max(target, SILENT);
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(gain.value, SILENT), now);
    gain.exponentialRampToValueAtTime(safeTarget, now + Math.max(seconds, 0.05));
  }

  private airBuffer(ctx: BaseAudioContext): AudioBuffer {
    const length = ctx.sampleRate * 3;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    let mean = 0;
    for (let i = 0; i < length; i++) {
      last = last * 0.985 + (Math.random() * 2 - 1) * 0.015;
      data[i] = last;
      mean += last;
    }
    mean /= length;
    let peak = 0;
    for (let i = 0; i < length; i++) {
      const sample = data[i] - mean;
      data[i] = sample;
      const abs = sample < 0 ? -sample : sample;
      if (abs > peak) peak = abs;
    }
    const scale = peak > 0 ? 0.9 / peak : 0;
    for (let i = 0; i < length; i++) data[i] *= scale;
    return buffer;
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("Ambient audio unavailable", err);
  }
}

export const ambient = new AmbientMusic();
