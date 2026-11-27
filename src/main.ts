import {
  ACESFilmicToneMapping,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  PostProcessing,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ambient } from "./audio/ambience";
import { CameraMode, CameraRig } from "./camera/cameraRig";
import { PLANETS } from "./data/planets";
import { EclipseKind, SolarSystem, ToolMode } from "./sim/solarSystem";
import { ToolPalette } from "./ui/toolPalette";
import { LabelLayer } from "./render/labels";
import { BOOT_WEIGHT, BootScreen, afterPaint, bootTotal } from "./ui/bootScreen";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const app = document.getElementById("app");
const bootRoot = document.getElementById("boot");
if (!app) throw new Error("Missing #app");
if (!bootRoot) throw new Error("Missing #boot");
const appEl: HTMLElement = app;

const loading = new BootScreen(bootRoot, bootTotal(PLANETS.length));
ambient.bindGesture(bootRoot);

void boot().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "알 수 없는 오류";
  loading.fail(message);
  console.error(err);
});

async function boot(): Promise<void> {
  loading.advance("singularity", BOOT_WEIGHT.runtime);
  await afterPaint();

  const scene = new Scene();
  const ambient = new AmbientLight(0x93a4c4, 0.04);
  ambient.layers.enableAll();
  scene.add(ambient);
  scene.add(createStarfield());
  loading.advance("inflation", BOOT_WEIGHT.starfield);
  await afterPaint();

  const camera = new PerspectiveCamera(55, 1, 0.1, 2000);
  camera.position.set(0, 55, 95);
  camera.layers.enableAll();

  const labels = new LabelLayer(appEl);
  const sim = new SolarSystem(scene, labels);
  loading.advance("inflation", BOOT_WEIGHT.sun);
  await afterPaint();

  const raycaster = new Raycaster();
  const pointer = new Vector2();

  await sim.buildPlanets(async () => {
    loading.advance("inflation", BOOT_WEIGHT.planet);
    await afterPaint();
  });

  loading.setStage("firstLight");
  await afterPaint();

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
    alpha: false,
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x02030a);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  await renderer.init();
  loading.advance("firstLight", BOOT_WEIGHT.gpu);

  loading.setStage("galaxy");
  await afterPaint();

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 8;
  controls.maxDistance = 400;

  const rig = new CameraRig({
    camera,
    controls,
    canvas,
    getFollowAnchor: (out) => {
      if (sim.selectedIds.size === 1) {
        const id = sim.selectedIds.values().next().value;
        const planet = id ? sim.planets.get(id) : undefined;
        if (planet && !planet.destroyed) return planet.mesh.getWorldPosition(out);
      }
      return sim.getFocusTarget().getWorldPosition(out);
    },
  });

  const scenePass = pass(scene, camera);
  const sceneColor = scenePass.getTextureNode("output");
  const bloomPass = bloom(sceneColor, 0.2, 0.25, 1.7);
  const post = new PostProcessing(renderer);
  post.outputNode = sceneColor.add(bloomPass);

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  const palette = new ToolPalette("sidebar", {
    getState: () => sim,
    onModeChange: (mode: ToolMode) => {
      sim.mode = mode;
      sim.playHint = "";
      sim.acts.clearResult();
    },
    onUseTool: (planetId, fast) => sim.useTool(planetId, fast),
    onEclipse: (kind: EclipseKind) => sim.playEclipse(kind),
    onRestoreOne: () => sim.restoreOne(),
    onReset: () => sim.resetAll(),
    onUndo: () => sim.undo(),
    onFocus: (planetId) => {
      sim.setFocus(planetId);
      const target = sim.getFocusTarget();
      const world = target.getWorldPosition(new Vector3());
      controls.target.copy(world);
    },
    onSelectPlanet: (planetId) => sim.toggleSelect(planetId),
    onTimeScale: (value) => {
      sim.timeScale = value;
      sim.paused = false;
    },
    onPauseToggle: (paused) => {
      sim.paused = paused;
    },
    onCameraMode: (mode: CameraMode) => rig.setMode(mode),
    getCameraMode: () => rig.mode,
  });
  rig.onChange = () => palette.refresh();

  function pickPlanet(clientX: number, clientY: number): string | null {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    raycaster.layers.enableAll();

    const meshes = [...sim.planets.values()]
      .filter((p) => !p.destroyed)
      .map((p) => p.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    return hits[0].object.userData.planetId as string;
  }

  function applyPick(e: PointerEvent): void {
    const id = pickPlanet(e.clientX, e.clientY);
    if (!id) {
      if (!e.shiftKey) sim.clearSelection();
      if (sim.mode !== "select") sim.playHint = "다음: 행성을 클릭하세요.";
      palette.refresh();
      return;
    }

    if (sim.mode === "select") {
      if (e.shiftKey) sim.toggleSelect(id);
      else sim.selectOnly(id);
    } else {
      sim.useTool(id, e.shiftKey);
    }
    palette.refresh();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (rig.mode === "free") {
      rig.beginPointer(e);
      return;
    }
    applyPick(e);
  });

  canvas.addEventListener("pointermove", (e) => {
    rig.movePointer(e);
  });

  canvas.addEventListener("pointerup", (e) => {
    if (rig.endPointer(e)) applyPick(e);
  });

  canvas.addEventListener("pointercancel", (e) => {
    rig.endPointer(e);
  });

  loading.advance("galaxy", BOOT_WEIGHT.galaxy);
  await afterPaint();
  loading.setStage("solar");
  await afterPaint();

  let opened = false;
  let last = performance.now();
  let paletteKey = "";
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    sim.update(dt);
    const nextKey = `${sim.hintText()}\n${sim.caption}\n${sim.listStates().map((item) => (item.destroyed ? "1" : "0")).join("")}`;
    if (nextKey !== paletteKey) {
      paletteKey = nextKey;
      palette.refresh();
    }

    rig.update(dt, () => {
      const focus = sim.getFocusTarget();
      if (sim.mode === "select" && sim.selectedIds.size === 1) {
        const id = [...sim.selectedIds][0];
        const planet = sim.planets.get(id);
        if (planet && !planet.destroyed) {
          controls.target.lerp(planet.mesh.position, 0.05);
          return;
        }
      }
      controls.target.lerp(focus.position, 0.02);
    });

    sim.layoutLabels(camera, window.innerWidth, window.innerHeight);
    post.render();
    if (!opened) {
      opened = true;
      loading.advance("solar", BOOT_WEIGHT.firstFrame);
      appEl.setAttribute("aria-busy", "false");
      loading.finish();
    }
  });
}

function createStarfield(): Points {
  const count = 2200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.PI * 2 * Math.random();
    const phi = Math.acos(2 * Math.random() - 1);
    const rad = 520;
    positions[i * 3] = rad * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = rad * Math.cos(phi);
    positions[i * 3 + 2] = rad * Math.sin(phi) * Math.sin(theta);
    const tint = 0.4 + Math.random() * 0.35;
    colors[i * 3] = tint;
    colors[i * 3 + 1] = tint * 0.95;
    colors[i * 3 + 2] = Math.min(1, tint + 0.08);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("color", new BufferAttribute(colors, 3));
  return new Points(
    geo,
    new PointsMaterial({
      size: 1.3,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    }),
  );
}
