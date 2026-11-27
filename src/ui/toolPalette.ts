import { ambient } from "../audio/ambience";
import { CameraMode } from "../camera/cameraRig";
import { SolarSystem, ToolMode } from "../sim/solarSystem";
import { PlanetInfoPanel } from "./planetInfoPanel";

const CAMERA_HINTS: Record<CameraMode, string> = {
  orbit: "드래그 회전 · 우클릭 이동 · 휠 줌. 더블클릭은 포커스.",
  follow: "선택된 행성(없으면 포커스)을 따라갑니다. 휠로 거리.",
  free: "WASD 이동 · 드래그 시점 · E/Space 상승 · Q/Ctrl 하강 · Shift 가속. 키 1/2/3.",
};

const MODE_HINTS: Record<ToolMode, string> = {
  select: "행성을 클릭하면 선택됩니다.",
  meteor: "다음: 행성을 클릭하세요. 운석이 날아와 부딪힙니다. Shift는 빠른 파편입니다.",
  blackhole: "다음: 행성을 클릭하세요. 블랙홀이 끌어당긴 뒤 삼킵니다.",
  laser: "다음: 행성을 클릭하세요. 광선이 행성을 태워 없앱니다.",
};

export interface ToolPaletteHandlers {
  onModeChange: (mode: ToolMode) => void;
  onUseTool: (planetId: string, fast: boolean) => void;
  onEclipse: (kind: "solar" | "lunar") => void;
  onSpawnSatellite: () => void;
  onSpawnSpacecraft: () => void;
  onRestoreOne: () => void;
  onReset: () => void;
  onUndo: () => void;
  onFocus: (planetId: string) => void;
  onSelectPlanet: (planetId: string) => void;
  onTimeScale: (value: number) => void;
  onPauseToggle: (paused: boolean) => void;
  onCameraMode: (mode: CameraMode) => void;
  getCameraMode: () => CameraMode;
  getState: () => SolarSystem;
}

export class ToolPalette {
  private readonly root: HTMLElement;
  private readonly handlers: ToolPaletteHandlers;
  private modeButtons: Partial<Record<ToolMode, HTMLButtonElement>> = {};
  private cameraButtons: Partial<Record<CameraMode, HTMLButtonElement>> = {};
  private camHint!: HTMLParagraphElement;
  private planetList!: HTMLUListElement;
  private undoBtn!: HTMLButtonElement;
  private timeLabel!: HTMLSpanElement;
  private pauseBtn!: HTMLButtonElement;
  private musicBtn!: HTMLButtonElement;
  private infoPanel!: PlanetInfoPanel;
  private toolHint!: HTMLParagraphElement;
  private captionEl!: HTMLDivElement;
  private panelToggle!: HTMLButtonElement;
  private panelReopen!: HTMLButtonElement;
  private panelOpen = true;

  constructor(rootId: string, handlers: ToolPaletteHandlers) {
    const el = document.getElementById(rootId);
    if (!el) throw new Error(`Missing #${rootId}`);
    this.root = el;
    this.handlers = handlers;
    this.render();
    this.refresh();
  }

  refresh(): void {
    const sim = this.handlers.getState();
    this.undoBtn.disabled = !sim.history.canUndo;

    for (const mode of ["select", "meteor", "blackhole", "laser"] as ToolMode[]) {
      this.modeButtons[mode]?.classList.toggle("active", sim.mode === mode);
    }
    const liveHint = sim.hintText();
    this.toolHint.textContent = liveHint || MODE_HINTS[sim.mode];
    this.captionEl.textContent = sim.caption;

    const cameraMode = this.handlers.getCameraMode();
    for (const mode of ["orbit", "follow", "free"] as CameraMode[]) {
      const btn = this.cameraButtons[mode];
      btn?.classList.toggle("active", cameraMode === mode);
      btn?.setAttribute("aria-pressed", String(cameraMode === mode));
    }
    this.camHint.textContent = CAMERA_HINTS[cameraMode];

    this.timeLabel.textContent = sim.paused
      ? "일시정지"
      : `${sim.timeScale.toFixed(2)}×`;
    this.pauseBtn.textContent = sim.paused ? "재생" : "일시정지";

    const items = sim.listStates();
    this.planetList.innerHTML = "";
    for (const item of items) {
      const li = document.createElement("li");
      li.classList.toggle("selected", sim.selectedIds.has(item.id));
      li.classList.toggle("destroyed", item.destroyed);

      const swatch = document.createElement("span");
      swatch.className = "planet-swatch";
      swatch.style.background = `#${item.color.toString(16).padStart(6, "0")}`;

      li.appendChild(swatch);
      li.appendChild(document.createTextNode(item.nameKo));

      li.addEventListener("click", (e) => {
        if (sim.mode === "select") {
          if (e.shiftKey) this.handlers.onSelectPlanet(item.id);
          else sim.selectOnly(item.id);
        } else {
          this.handlers.onUseTool(item.id, e.shiftKey);
        }
        this.refresh();
      });

      li.addEventListener("dblclick", () => {
        this.handlers.onFocus(item.id);
      });

      this.planetList.appendChild(li);
    }

    this.infoPanel.show(sim.selectedIds);
    this.syncMusicButton();
  }

  private render(): void {
    this.root.innerHTML = `
      <button type="button" class="tool-btn" id="panel-toggle">패널 닫기</button>
      <p class="panel-title">우주 도구</p>
      <section class="tool-group">
        <h3>소리</h3>
        <button type="button" class="tool-btn" id="music-toggle" data-music-toggle>배경음 켜짐</button>
      </section>
      <section class="tool-group" id="planet-info" aria-live="polite"></section>
      <section class="tool-group">
        <h3>파괴</h3>
        <div class="btn-row" id="mode-row"></div>
        <p class="tool-hint" id="tool-hint"></p>
      </section>
      <section class="tool-group">
        <h3>식</h3>
        <div class="btn-row">
          <button type="button" class="tool-btn" data-action="solar">개기일식</button>
          <button type="button" class="tool-btn" data-action="lunar">개기월식</button>
        </div>
      </section>
      <section class="tool-group">
        <h3>기체</h3>
        <div class="btn-row">
          <button type="button" class="tool-btn" data-action="satellite">위성</button>
          <button type="button" class="tool-btn" data-action="spacecraft">우주선</button>
        </div>
        <p class="scale-note">클릭할 때마다 한 대씩 늘어납니다. 위성은 궤도, 우주선은 속도입니다.</p>
      </section>
      <section class="tool-group">
        <h3>카메라</h3>
        <div class="btn-row" id="camera-row"></div>
        <p class="scale-note" id="cam-hint"></p>
      </section>
      <section class="tool-group">
        <h3>되돌리기</h3>
        <div class="btn-row">
          <button type="button" class="tool-btn" data-action="restore">하나 복원</button>
          <button type="button" class="tool-btn" data-action="reset">전체 리셋</button>
          <button type="button" class="tool-btn" id="undo-btn" data-action="undo">실행 취소</button>
        </div>
      </section>
      <section class="tool-group">
        <h3>시간</h3>
        <button type="button" class="tool-btn" id="pause-btn" style="width:100%">일시정지</button>
        <label class="range-row">
          <span>배율 <span id="time-label">1×</span> (0.25×–100×)</span>
          <input type="range" id="time-scale" min="0" max="100" step="0.25" value="1" />
        </label>
      </section>
      <section class="tool-group">
        <h3>행성 (클릭은 현재 도구, 더블클릭 포커스)</h3>
        <ul class="planet-list" id="planet-list"></ul>
        <p class="scale-note">
          궤도·크기는 교육용 로그 스케일입니다. 실제 AU/반지름 비율은 HUD와 README에 표기합니다.
        </p>
      </section>
    `;

    const modeRow = this.root.querySelector("#mode-row")!;
    const modes: { id: ToolMode; label: string }[] = [
      { id: "select", label: "선택" },
      { id: "meteor", label: "운석" },
      { id: "blackhole", label: "블랙홀" },
      { id: "laser", label: "광선" },
    ];
    for (const m of modes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.textContent = m.label;
      btn.addEventListener("click", () => {
        this.handlers.onModeChange(m.id);
        this.refresh();
      });
      modeRow.appendChild(btn);
      this.modeButtons[m.id] = btn;
    }

    const cameraRow = this.root.querySelector("#camera-row")!;
    const cameras: { id: CameraMode; label: string }[] = [
      { id: "orbit", label: "궤도" },
      { id: "follow", label: "추적" },
      { id: "free", label: "자유 비행" },
    ];
    for (const m of cameras) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.textContent = m.label;
      btn.addEventListener("click", () => {
        this.handlers.onCameraMode(m.id);
        this.refresh();
      });
      cameraRow.appendChild(btn);
      this.cameraButtons[m.id] = btn;
    }

    this.camHint = this.root.querySelector("#cam-hint")!;
    const hint = this.root.querySelector("#tool-hint");
    if (!(hint instanceof HTMLParagraphElement)) throw new Error("Missing #tool-hint");
    this.toolHint = hint;
    this.planetList = this.root.querySelector("#planet-list")!;
    this.captionEl = document.createElement("div");
    this.captionEl.className = "event-caption";
    this.captionEl.setAttribute("aria-live", "polite");
    document.getElementById("app")?.appendChild(this.captionEl);
    const toggle = this.root.querySelector("#panel-toggle");
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("Missing #panel-toggle");
    this.panelToggle = toggle;
    this.panelToggle.addEventListener("click", () => this.setPanelOpen(false));
    this.panelReopen = document.createElement("button");
    this.panelReopen.type = "button";
    this.panelReopen.id = "panel-reopen";
    this.panelReopen.setAttribute("aria-label", "패널 열기");
    const bars = document.createElement("span");
    bars.className = "hamburger";
    bars.setAttribute("aria-hidden", "true");
    this.panelReopen.appendChild(bars);
    this.panelReopen.addEventListener("click", () => this.setPanelOpen(true));
    document.getElementById("app")?.appendChild(this.panelReopen);
    this.syncPanelToggle();
    const infoRoot = this.root.querySelector("#planet-info");
    if (!(infoRoot instanceof HTMLElement)) {
      throw new Error("Missing #planet-info");
    }
    this.infoPanel = new PlanetInfoPanel(infoRoot);
    this.undoBtn = this.root.querySelector("#undo-btn")!;
    this.timeLabel = this.root.querySelector("#time-label")!;
    this.pauseBtn = this.root.querySelector("#pause-btn")!;
    const musicBtn = this.root.querySelector("#music-toggle");
    if (!(musicBtn instanceof HTMLButtonElement)) throw new Error("Missing #music-toggle");
    this.musicBtn = musicBtn;
    this.musicBtn.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    this.musicBtn.addEventListener("click", () => {
      ambient.toggleMuted();
      this.syncMusicButton();
    });
    this.syncMusicButton();

    this.root.querySelectorAll("[data-action]").forEach((node) => {
      const btn = node as HTMLButtonElement;
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        switch (action) {
          case "solar":
            this.handlers.onEclipse("solar");
            break;
          case "lunar":
            this.handlers.onEclipse("lunar");
            break;
          case "satellite":
            this.handlers.onSpawnSatellite();
            break;
          case "spacecraft":
            this.handlers.onSpawnSpacecraft();
            break;
          case "restore":
            this.handlers.onRestoreOne();
            break;
          case "reset":
            this.handlers.onReset();
            break;
          case "undo":
            this.handlers.onUndo();
            break;
        }
        this.refresh();
      });
    });

    this.pauseBtn.addEventListener("click", () => {
      const sim = this.handlers.getState();
      this.handlers.onPauseToggle(!sim.paused);
      this.refresh();
    });

    const slider = this.root.querySelector("#time-scale") as HTMLInputElement;
    const mapScale = (v: number): number => {
      if (v <= 1) return 0.25 + (v / 1) * 0.75;
      return 1 + ((v - 1) / 99) * 99;
    };
    slider.addEventListener("input", () => {
      const raw = Number(slider.value);
      const scale = mapScale(raw);
      this.handlers.onTimeScale(scale);
      this.refresh();
    });
  }

  private setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    this.root.classList.toggle("is-closed", !open);
    document.getElementById("app")?.classList.toggle("panel-closed", !open);
    this.syncPanelToggle();
  }

  private syncPanelToggle(): void {
    const expanded = String(this.panelOpen);
    this.panelToggle.setAttribute("aria-expanded", expanded);
    this.panelToggle.setAttribute("aria-controls", "sidebar");
    this.panelReopen.setAttribute("aria-expanded", expanded);
    this.panelReopen.setAttribute("aria-controls", "sidebar");
    this.panelReopen.hidden = this.panelOpen;
  }

  private syncMusicButton(): void {
    const on = !ambient.isMuted();
    this.musicBtn.textContent = on ? "배경음 켜짐" : "배경음 꺼짐";
    this.musicBtn.classList.toggle("active", on);
    this.musicBtn.setAttribute("aria-pressed", String(on));
  }
}