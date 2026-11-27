const LEVEL = 0.16;
const SILENT = 0.0001;
const FADE_IN_SEC = 8;
const FADE_OUT_SEC = 4;

/**
 * Quiet low pad: a few detuned sines and long fades. No noise, no samples.
 * The context is created on the first gesture.
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
    }
    if (!this.muted) this.fadeTo(LEVEL, this.master!.gain.value > 0.02 ? 4 : FADE_IN_SEC);
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
    this.tone(ctx, master, 55, 0, 0.18);
    this.tone(ctx, master, 55, 5, 0.14);
    this.tone(ctx, master, 82.41, -3, 0.045);
  }

  private tone(
    ctx: AudioContext,
    dest: AudioNode,
    freq: number,
    detuneCents: number,
    level: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.detune.value = detuneCents;
    gain.gain.value = level;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
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

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn("Ambient audio unavailable", err);
  }
}

export const ambient = new AmbientMusic();
