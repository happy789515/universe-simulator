const STAGE_LABEL = {
  singularity: "특이점",
  inflation: "급팽창",
  firstLight: "첫 빛",
  galaxy: "은하",
  solar: "태양계",
} as const;

export type BootStage = keyof typeof STAGE_LABEL;

/** Relative cost of real startup steps. Planet count is applied by the caller. */
export const BOOT_WEIGHT = {
  runtime: 4,
  starfield: 3,
  sun: 8,
  planet: 12,
  gpu: 36,
  galaxy: 6,
  firstFrame: 32,
} as const;

export function bootTotal(planetCount: number): number {
  return (
    BOOT_WEIGHT.runtime +
    BOOT_WEIGHT.starfield +
    BOOT_WEIGHT.sun +
    BOOT_WEIGHT.planet * planetCount +
    BOOT_WEIGHT.gpu +
    BOOT_WEIGHT.galaxy +
    BOOT_WEIGHT.firstFrame
  );
}

/** Resolves after the browser has painted the pending DOM update. */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

export class BootScreen {
  private readonly stageEl: HTMLElement;
  private readonly pctEl: HTMLElement;
  private readonly fill: HTMLElement;
  private done = 0;
  private finished = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly total: number,
  ) {
    const stageEl = root.querySelector<HTMLElement>("[data-boot-stage]");
    const pctEl = root.querySelector<HTMLElement>("[data-boot-pct]");
    const fill = root.querySelector<HTMLElement>("[data-boot-fill]");
    if (!stageEl || !pctEl || !fill) throw new Error("Missing boot screen nodes");
    this.stageEl = stageEl;
    this.pctEl = pctEl;
    this.fill = fill;
  }

  setStage(stage: BootStage): void {
    this.render(stage);
  }

  advance(stage: BootStage, weight: number): void {
    if (weight < 0 || !Number.isFinite(weight)) throw new Error("Invalid boot weight");
    this.done += weight;
    this.render(stage);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.done = this.total;
    this.render("solar");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      this.root.remove();
      return;
    }
    const remove = () => this.root.remove();
    this.root.addEventListener("transitionend", remove, { once: true });
    this.root.classList.add("is-done");
    window.setTimeout(remove, 320);
  }

  fail(message: string): void {
    this.finished = true;
    this.stageEl.textContent = "시작 실패";
    this.pctEl.textContent = message;
    this.root.classList.add("is-error");
  }

  private render(stage: BootStage): void {
    const label = STAGE_LABEL[stage];
    const pct =
      this.total <= 0 ? 0 : Math.min(100, Math.round((this.done / this.total) * 100));
    this.stageEl.textContent = label;
    this.pctEl.textContent = `${pct}%`;
    this.fill.style.width = `${pct}%`;
    this.root.style.setProperty("--p", String(pct));
    this.root.setAttribute("aria-valuenow", String(pct));
    this.root.setAttribute("aria-valuetext", `${label} ${pct}%`);
  }
}
