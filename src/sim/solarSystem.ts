import {
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  SphereGeometry,
  Vector3,
} from "three/webgpu";
import type { Scene } from "three/webgpu";
import {
  PLANETS,
  PlanetDefinition,
  sunRadiusSceneUnits,
} from "../data/planets";
import { sfx } from "../audio/sfx";
import { ParticleSystem } from "../effects/particles";
import { LabelLayer } from "../render/labels";
import { createPlanetLook, createSunCorona, createSunMaterial } from "../render/surfaces";
import type { AtmoFade } from "../render/surfaces";
import { ActPlayer, APPROACH } from "./acts";
import type { ActBody } from "./acts";
import { HistoryStack } from "./history";
import type { BodySnapshot, DeathAct, ScarPoint, SimAction } from "./history";
import {
  bodyRadiusAu,
  earthExposure,
  isEclipsed,
  writeOrbitTrail,
  writePlanetAu,
  writePlanetScene,
} from "./kepler";

export type ToolMode = "select" | "meteor" | "blackhole" | "laser";
export type EclipseKind = "solar" | "lunar";

const TRAIL_STEPS = 128;

interface PlanetRuntime extends ActBody {
  def: PlanetDefinition;
  group: Group;
  orbitLine: Line;
  orbitPositions: Float32Array;
  orbitColors: Float32Array;
  light: DirectionalLight;
  atmosphere: Mesh | null;
  atmoFade: AtmoFade | null;
  clouds: Mesh | null;
  epoch: number;
  spin: number;
  label: HTMLDivElement;
  nightEmissive: number;
  nightLevel: number;
  au: Vector3;
  auDistance: number;
}

interface DebrisBurst {
  positions: Float32Array;
  velocities: Float32Array;
  points: Points;
  life: number;
  fade: number;
  planetId: string;
}

interface EclipsePlay {
  kind: EclipseKind;
  t: number;
  move: number;
  hold: number;
  from: number;
  to: number;
}

export class SolarSystem {
  readonly scene: Scene;
  readonly root = new Group();
  readonly planets = new Map<string, PlanetRuntime>();
  readonly sun: Mesh;
  readonly history = new HistoryStack();
  readonly particles: ParticleSystem;

  selectedIds = new Set<string>();
  mode: ToolMode = "select";
  timeScale = 1;
  paused = false;
  simDays = 0;
  playHint = "";
  caption = "";

  readonly acts: ActPlayer<PlanetRuntime>;

  private appliedScale = 1;
  private readonly debris: DebrisBurst[] = [];
  private focusId: string | null = null;
  private readonly previewHit: Mesh;
  private readonly previewLine: Line;
  private readonly labels: LabelLayer;
  private readonly ndc = new Vector3();
  private readonly moonSide = new Vector3();
  private moonAngle = 1.15;
  private moonLocked = false;
  private eclipse: EclipsePlay | null = null;
  private solarCover = 0;
  private lunarCover = 0;
  private meteorAim = true;
  private readonly moonMesh: Mesh;
  private readonly moonMat: MeshStandardMaterial;
  private readonly moonLight: DirectionalLight;
  private readonly moonLabel: HTMLDivElement;
  private readonly umbra: Mesh;
  private readonly lunarShadow: Mesh;

  constructor(scene: Scene, labels: LabelLayer) {
    this.scene = scene;
    this.labels = labels;
    this.particles = new ParticleSystem(scene);
    scene.add(this.root);

    const sunGeo = new SphereGeometry(sunRadiusSceneUnits(), 48, 48);
    this.sun = new Mesh(sunGeo, createSunMaterial());
    this.sun.name = "sun";
    this.sun.add(createSunCorona(sunRadiusSceneUnits()));
    this.root.add(this.sun);
    const sunLabel = labels.create("태양");
    sunLabel.dataset.role = "sun";

    const hitGeo = new SphereGeometry(0.12, 12, 8);
    this.previewHit = new Mesh(
      hitGeo,
      new MeshBasicMaterial({ color: 0xfff3c4 }),
    );
    this.previewHit.visible = false;
    this.previewHit.renderOrder = 2;
    this.root.add(this.previewHit);

    const lineGeo = new BufferGeometry();
    lineGeo.setAttribute("position", new BufferAttribute(new Float32Array(6), 3));
    this.previewLine = new Line(
      lineGeo,
      new LineBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.85 }),
    );
    this.previewLine.visible = false;
    this.previewLine.frustumCulled = false;
    this.root.add(this.previewLine);

    this.moonMat = new MeshStandardMaterial({ color: 0xd6d3d1, roughness: 0.95, metalness: 0 });
    this.moonMesh = new Mesh(new SphereGeometry(0.42, 24, 16), this.moonMat);
    this.moonMesh.name = "moon";
    this.moonMesh.layers.set(9);
    this.moonLight = new DirectionalLight(0xfff3d6, 2.2);
    this.moonLight.layers.set(9);
    this.moonLight.target = this.moonMesh;
    this.root.add(this.moonLight);
    this.root.add(this.moonMesh);
    this.moonLabel = labels.create("달");

    this.umbra = new Mesh(
      new SphereGeometry(1, 20, 12),
      new MeshBasicMaterial({ color: 0x020617, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.umbra.visible = false;
    this.root.add(this.umbra);
    this.lunarShadow = new Mesh(
      new SphereGeometry(0.72, 18, 12),
      new MeshBasicMaterial({ color: 0x1c0a0a, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.lunarShadow.visible = false;
    this.root.add(this.lunarShadow);

    this.acts = new ActPlayer(
      scene,
      this.planets,
      this.history,
      this.particles,
      (id) => this.hideBody(id),
      (id) => this.showBody(id),
      () => this.updateSelectionVisuals(),
      (id, at) => {
        const planet = this.planets.get(id);
        if (planet) this.spawnDebris(planet, at, false);
      },
      (id) => this.recallDebris(id),
    );
  }

  async buildPlanets(onBody: () => void | Promise<void>): Promise<void> {
    for (const [index, def] of PLANETS.entries()) {
      this.createPlanet(def, index);
      await onBody();
    }
  }

  private createPlanet(def: PlanetDefinition, index: number): void {
    const look = createPlanetLook(def);
    const group = new Group();
    group.name = def.id;

    const orbitPositions = new Float32Array(TRAIL_STEPS * 3);
    const orbitColors = new Float32Array(TRAIL_STEPS * 3);
    const orbitGeo = new BufferGeometry();
    orbitGeo.setAttribute("position", new BufferAttribute(orbitPositions, 3));
    orbitGeo.setAttribute("color", new BufferAttribute(orbitColors, 3));
    const orbitLine = new Line(
      orbitGeo,
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }),
    );
    orbitLine.frustumCulled = false;
    group.add(orbitLine);

    const mesh = look.mesh;
    mesh.userData.planetId = def.id;
    mesh.rotation.order = "ZXY";
    mesh.rotation.z = (def.axialTiltDeg * Math.PI) / 180;
    const layer = index + 1;
    mesh.layers.set(layer);
    look.clouds?.layers.set(layer);
    look.atmosphere?.layers.set(layer);
    look.rings?.layers.set(layer);
    mesh.traverse((child) => {
      child.layers.set(layer);
    });

    const light = new DirectionalLight(0xfff3d6, 3.2);
    light.layers.set(layer);
    light.target.layers.set(layer);
    group.add(light);
    group.add(light.target);
    group.add(mesh);

    const runtime: PlanetRuntime = {
      id: def.id,
      def,
      group,
      mesh,
      material: look.material,
      orbitLine,
      orbitPositions,
      orbitColors,
      light,
      atmosphere: look.atmosphere,
      atmoFade: look.atmoFade,
      clouds: look.clouds,
      destroyed: false,
      death: null,
      epoch: (def.meanAnomalyDeg * Math.PI) / 180,
      eOffset: 0,
      mOffset: 0,
      spin: 0,
      scars: [],
      label: this.labels.create(def.nameKo),
      radius: look.radius,
      color: def.color,
      visualScale: 1,
      pull: new Vector3(),
      layoutScale: 1,
      nightEmissive: look.nightEmissive,
      nightLevel: look.nightLevel,
      au: new Vector3(),
      auDistance: def.semiMajorAxisAu,
    };
    this.root.add(group);
    this.planets.set(def.id, runtime);
    this.syncPlanet(runtime);
  }

  getFocusTarget(): Object3D {
    if (this.focusId) {
      const planet = this.planets.get(this.focusId);
      if (planet && !planet.destroyed) return planet.mesh;
    }
    return this.sun;
  }

  setFocus(planetId: string | null): void {
    this.focusId = planetId;
  }

  toggleSelect(planetId: string): void {
    if (this.selectedIds.has(planetId)) this.selectedIds.delete(planetId);
    else {
      this.selectedIds.add(planetId);
      sfx.playSelect();
    }
    this.updateSelectionVisuals();
  }

  clearSelection(): void {
    this.selectedIds.clear();
    this.updateSelectionVisuals();
  }

  selectOnly(planetId: string): void {
    this.selectedIds.clear();
    this.selectedIds.add(planetId);
    sfx.playSelect();
    this.updateSelectionVisuals();
  }

  private updateSelectionVisuals(): void {
    for (const [id, planet] of this.planets) {
      const mat = planet.material;
      if (planet.destroyed) continue;
      if (this.selectedIds.has(id)) {
        mat.emissive.setHex(0x8ecbff);
        mat.emissiveIntensity = 0.4;
      } else {
        mat.emissive.setHex(planet.nightEmissive);
        mat.emissiveIntensity = planet.nightLevel;
      }
    }
  }

  armMeteorPreview(): void {
    this.meteorAim = true;
  }

  hintText(): string {
    return this.playHint || this.acts.statusHint || this.acts.resultHint;
  }

  useTool(planetId: string, fast: boolean): void {
    if (this.blocked()) return;
    const planet = this.planets.get(planetId);
    if (!planet || planet.destroyed) {
      this.acts.resultHint = "이미 파괴된 행성입니다. 복원이나 실행 취소를 누르세요.";
      return;
    }
    this.selectOnly(planetId);
    if (this.mode === "select") return;
    if (this.mode === "meteor") this.meteorAim = false;
    sfx.prime();
    this.acts.launch(this.mode, planetId, fast);
  }

  playEclipse(kind: EclipseKind): void {
    if (this.blocked()) return;
    const earth = this.planets.get("earth");
    if (!earth || earth.destroyed) {
      this.acts.resultHint = "지구가 있어야 식을 볼 수 있습니다.";
      return;
    }
    const target = kind === "solar" ? 0 : Math.PI;
    const delta = Math.atan2(Math.sin(target - this.moonAngle), Math.cos(target - this.moonAngle));
    this.eclipse = {
      kind,
      t: 0,
      move: 1.45,
      hold: 2.5,
      from: this.moonAngle,
      to: this.moonAngle + delta,
    };
    this.moonLocked = true;
    this.caption =
      kind === "solar"
        ? "개기일식 · 달이 태양을 가려 지구에 그림자가 집니다"
        : "개기월식 · 지구 그림자가 달을 붉게 덮습니다";
    this.playHint = this.caption;
  }

  restoreOne(): void {
    if (this.blocked()) return;
    const id = [...this.acts.deathOrder].reverse().find((key) => this.planets.get(key)?.destroyed);
    if (id) {
      const act = this.planets.get(id)?.death ?? "laser";
      this.acts.playReverse(id, act, true);
      return;
    }
    const top = this.history.peek();
    if (top?.kind === "impact") {
      this.undo();
      return;
    }
    this.acts.resultHint = "복원할 행성이 없습니다.";
  }

  undo(): void {
    if (this.blocked()) return;
    const action = this.history.pop();
    if (!action) {
      this.acts.resultHint = "되돌릴 행동이 없습니다.";
      return;
    }
    if (action.kind === "impact") this.acts.playImpactReverse(action);
    else if (action.kind === "destroy") this.acts.playReverse(action.planetId, action.act, false);
    else if (action.kind === "restore") this.acts.playForward(action.planetId, action.act, false);
    else this.undoReset(action);
  }

  resetAll(): void {
    if (this.blocked()) return;
    const destroyedIds = this.acts.deathOrder.filter((id) => this.planets.get(id)?.destroyed);
    const bodies = [...this.planets.values()].map((planet) => this.snapshot(planet));
    const priorDays = this.simDays;
    this.history.push({
      kind: "reset",
      destroyedIds: [...destroyedIds],
      simDays: priorDays,
      bodies,
    });
    for (const id of [...destroyedIds].reverse()) {
      const act = this.planets.get(id)?.death ?? "laser";
      this.acts.playReverse(id, act, false, 0.85);
    }
    let tracks: { id: string; fromE: number; fromM: number }[] | null = null;
    let fromDays = priorDays;
    this.acts.playRewind(
      1.2,
      (u) => {
        if (!tracks) {
          fromDays = this.simDays;
          tracks = [...this.planets.values()].map((planet) => ({
            id: planet.id,
            fromE: planet.eOffset,
            fromM: planet.mOffset,
          }));
        }
        this.simDays = fromDays * (1 - u);
        for (const track of tracks) {
          const planet = this.planets.get(track.id);
          if (!planet) continue;
          planet.eOffset = track.fromE * (1 - u);
          planet.mOffset = track.fromM * (1 - u);
          for (const scar of planet.scars) scar.scale.setScalar(Math.max(0.001, 1 - u));
        }
      },
      () => {
        for (const planet of this.planets.values()) {
          planet.eOffset = 0;
          planet.mOffset = 0;
          this.clearScars(planet);
        }
        this.simDays = 0;
        this.moonLocked = false;
        this.moonAngle = 1.15;
        this.eclipse = null;
        this.caption = "";
        this.clearDebris();
        this.selectedIds.clear();
        this.acts.resultHint = "파괴를 역순으로 되돌리고 궤도를 되감았습니다.";
        this.updateSelectionVisuals();
      },
    );
  }

  private undoReset(action: Extract<SimAction, { kind: "reset" }>): void {
    const fromDays = this.simDays;
    const tracks = action.bodies.map((snap) => {
      const planet = this.planets.get(snap.id);
      return {
        id: snap.id,
        fromE: planet?.eOffset ?? 0,
        toE: snap.eOffset,
        fromM: planet?.mOffset ?? 0,
        toM: snap.mOffset,
      };
    });
    this.acts.playRewind(
      1.15,
      (u) => {
        this.simDays = fromDays + (action.simDays - fromDays) * u;
        for (const track of tracks) {
          const planet = this.planets.get(track.id);
          if (!planet) continue;
          planet.eOffset = track.fromE + (track.toE - track.fromE) * u;
          planet.mOffset = track.fromM + (track.toM - track.fromM) * u;
        }
      },
      () => {
        this.simDays = action.simDays;
        for (const snap of action.bodies) this.applySnapshot(snap);
        this.syncAll();
      },
    );
    for (const id of action.destroyedIds) {
      const snap = action.bodies.find((body) => body.id === id);
      const act: DeathAct = snap?.death ?? "laser";
      this.acts.playForward(id, act, false, 0.85);
    }
  }

  private blocked(): boolean {
    if (this.acts.busy || this.eclipse) {
      this.playHint = "재생이 끝난 뒤 다시 누르세요.";
      return true;
    }
    this.playHint = "";
    return false;
  }

  private hideBody(id: string): void {
    const planet = this.planets.get(id);
    if (!planet) return;
    planet.mesh.visible = false;
    planet.light.intensity = 0;
    planet.orbitLine.visible = false;
    planet.label.style.opacity = "0";
    this.selectedIds.delete(id);
  }

  private showBody(id: string): void {
    const planet = this.planets.get(id);
    if (!planet) return;
    planet.mesh.visible = true;
    planet.orbitLine.visible = true;
    (planet.orbitLine.material as LineBasicMaterial).opacity = 0.95;
  }

  private removeScar(planet: PlanetRuntime, index: number): void {
    const scar = planet.scars[index];
    if (!scar) return;
    planet.mesh.remove(scar);
    scar.geometry.dispose();
    (scar.material as MeshStandardMaterial).dispose();
    planet.scars.splice(index, 1);
  }

  private clearScars(planet: PlanetRuntime): void {
    while (planet.scars.length > 0) this.removeScar(planet, planet.scars.length - 1);
  }

  private spawnDebris(planet: PlanetRuntime, origin: Vector3, home: boolean): void {
    const count = 16;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const speed = 3.5 + Math.random() * 6;
      const radius = home ? 2.4 + Math.random() * 2.2 : 0;
      positions[i * 3] = origin.x + dir.x * radius;
      positions[i * 3 + 1] = origin.y + dir.y * radius;
      positions[i * 3 + 2] = origin.z + dir.z * radius;
      const sign = home ? -1 : 1;
      velocities[i * 3] = dir.x * speed * sign + APPROACH.x * -2;
      velocities[i * 3 + 1] = dir.y * speed * sign + APPROACH.y * -2;
      velocities[i * 3 + 2] = dir.z * speed * sign + APPROACH.z * -2;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(positions, 3));
    const points = new Points(
      geo,
      new PointsMaterial({
        color: 0xfdba74,
        size: 2.6,
        sizeAttenuation: false,
        transparent: true,
      }),
    );
    this.scene.add(points);
    this.debris.push({
      positions,
      velocities,
      points,
      life: 0,
      fade: home ? 1.3 : 1.5,
      planetId: planet.id,
    });
  }

  private recallDebris(id: string): void {
    const planet = this.planets.get(id);
    if (!planet) return;
    const live = this.debris.filter((burst) => burst.planetId === id);
    if (live.length === 0) {
      this.spawnDebris(planet, planet.mesh.position.clone(), true);
      return;
    }
    for (const burst of live) {
      burst.life = 0;
      burst.fade = 1.3;
      for (let p = 0; p < burst.velocities.length; p++) burst.velocities[p] *= -1;
    }
  }

  private clearDebris(): void {
    for (const burst of this.debris) {
      this.scene.remove(burst.points);
      burst.points.geometry.dispose();
      (burst.points.material as PointsMaterial).dispose();
    }
    this.debris.length = 0;
  }

  private snapshot(planet: PlanetRuntime): BodySnapshot {
    return {
      id: planet.id,
      epoch: planet.epoch,
      eOffset: planet.eOffset,
      mOffset: planet.mOffset,
      death: planet.death,
      scars: planet.scars.map((scar) => ({
        x: scar.position.x,
        y: scar.position.y,
        z: scar.position.z,
      })),
    };
  }

  private applySnapshot(snap: BodySnapshot): void {
    const planet = this.planets.get(snap.id);
    if (!planet) return;
    planet.epoch = snap.epoch;
    planet.eOffset = snap.eOffset;
    planet.mOffset = snap.mOffset;
    this.clearScars(planet);
    for (const point of snap.scars) this.addScarAt(planet, point);
  }

  private addScarAt(planet: PlanetRuntime, point: ScarPoint): void {
    const scar = new Mesh(
      new SphereGeometry(planet.radius * 0.07, 10, 8),
      new MeshStandardMaterial({ color: 0x1a100c, roughness: 1, metalness: 0 }),
    );
    scar.position.set(point.x, point.y, point.z);
    scar.layers.mask = planet.mesh.layers.mask;
    planet.mesh.add(scar);
    planet.scars.push(scar);
  }

  private syncPlanet(planet: PlanetRuntime): void {
    planet.auDistance = writePlanetScene(
      planet.def,
      this.simDays,
      planet.epoch,
      planet.eOffset,
      planet.mOffset,
      planet.mesh.position,
    );
    writePlanetAu(
      planet.def,
      planet.epoch +
        ((2 * Math.PI) / planet.def.orbitalPeriodDays) * this.simDays +
        planet.mOffset,
      planet.eOffset,
      planet.au,
    );
    planet.light.position.set(0, 0, 0);
    planet.light.target.position.copy(planet.mesh.position);
    writeOrbitTrail(
      planet.def,
      this.simDays,
      planet.epoch,
      planet.eOffset,
      planet.mOffset,
      planet.orbitPositions,
      planet.orbitColors,
      TRAIL_STEPS,
    );
    const posAttr = planet.orbitLine.geometry.getAttribute("position") as BufferAttribute;
    const colAttr = planet.orbitLine.geometry.getAttribute("color") as BufferAttribute;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  private syncAll(): void {
    for (const planet of this.planets.values()) this.syncPlanet(planet);
  }

  private updatePreview(): void {
    const id = [...this.selectedIds].find((key) => {
      const planet = this.planets.get(key);
      return planet && !planet.destroyed;
    });
    const planet = id ? this.planets.get(id) : undefined;
    const idle = !this.acts.busy && !this.eclipse && planet !== undefined;
    const meteor = idle && this.mode === "meteor" && this.meteorAim;
    const hole = idle && this.mode === "blackhole";
    const laser = idle && this.mode === "laser";
    this.previewHit.visible = meteor || hole;
    this.previewLine.visible = meteor || laser;
    if (!idle || !planet) return;
    const center = planet.mesh.position.clone().sub(planet.pull);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const hitMat = this.previewHit.material;
    if (!(hitMat instanceof MeshBasicMaterial)) return;
    const attr = this.previewLine.geometry.getAttribute("position") as BufferAttribute;
    if (hole) {
      const side = new Vector3().crossVectors(center.clone().normalize(), new Vector3(0, 1, 0));
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
      side.normalize();
      this.previewHit.position.copy(center).addScaledVector(side, 7);
      this.previewHit.scale.setScalar(6);
      hitMat.color.setHex(0x000000);
      return;
    }
    const hit = center.clone().addScaledVector(APPROACH, reach);
    const start = laser
      ? center.clone().set(center.x, center.y + 16 + reach, center.z)
      : center.clone().addScaledVector(APPROACH, 18 + reach);
    this.previewHit.position.copy(hit);
    this.previewHit.scale.setScalar(meteor ? 3.2 : 1);
    hitMat.color.setHex(laser ? 0xe0f2fe : 0xfff3c4);
    attr.setXYZ(0, start.x, start.y, start.z);
    attr.setXYZ(1, hit.x, hit.y, hit.z);
    attr.needsUpdate = true;
    this.previewLine.geometry.computeBoundingSphere();
    const lineMat = this.previewLine.material;
    if (lineMat instanceof LineBasicMaterial) lineMat.color.setHex(laser ? 0xbae6fd : 0xfde68a);
  }

  private stepMoon(dt: number): void {
    const eclipse = this.eclipse;
    if (eclipse) {
      eclipse.t += dt;
      const u = Math.min(1, eclipse.t / eclipse.move);
      const eased = u * u * (3 - 2 * u);
      this.moonAngle = eclipse.from + (eclipse.to - eclipse.from) * eased;
      if (eclipse.t >= eclipse.move + eclipse.hold) {
        this.moonAngle = eclipse.to;
        const kind = eclipse.kind;
        this.eclipse = null;
        this.caption = "";
        this.playHint =
          kind === "solar"
            ? "달이 해와 지구 사이에 머뭅니다."
            : "달이 지구 그림자에 머뭅니다.";
      }
    } else if (!this.moonLocked) {
      this.moonAngle += dt * 0.22;
    }

    const earth = this.planets.get("earth");
    if (!earth || earth.destroyed) {
      this.moonMesh.visible = false;
      this.umbra.visible = false;
      this.lunarShadow.visible = false;
      this.solarCover = 0;
      this.lunarCover = 0;
      return;
    }
    this.moonMesh.visible = true;
    const center = earth.mesh.position;
    const radial = center.clone();
    if (radial.lengthSq() < 1e-8) radial.set(1, 0, 0);
    else radial.normalize();
    this.moonSide.crossVectors(radial, new Vector3(0, 1, 0));
    if (this.moonSide.lengthSq() < 1e-8) this.moonSide.crossVectors(radial, new Vector3(1, 0, 0));
    this.moonSide.normalize();
    const dist = Math.max(2.8, earth.radius * earth.layoutScale * 3.4);
    this.moonMesh.position
      .copy(center)
      .addScaledVector(radial, -Math.cos(this.moonAngle) * dist)
      .addScaledVector(this.moonSide, Math.sin(this.moonAngle) * dist);
    this.moonMesh.scale.setScalar(Math.max(0.72, earth.layoutScale * 0.42));
    this.moonLight.position.set(0, 0, 0);
    this.moonLight.target.position.copy(this.moonMesh.position);

    const solarGap = Math.atan2(Math.sin(this.moonAngle), Math.cos(this.moonAngle));
    const lunarGap = Math.atan2(Math.sin(this.moonAngle - Math.PI), Math.cos(this.moonAngle - Math.PI));
    this.solarCover = Math.exp(-(solarGap * solarGap) / 0.04);
    this.lunarCover = Math.exp(-(lunarGap * lunarGap) / 0.04);

    const reach = earth.radius * earth.layoutScale;
    this.umbra.position.copy(center).addScaledVector(radial, -reach * 0.9);
    this.umbra.lookAt(0, 0, 0);
    this.umbra.scale.set(reach * 0.78, reach * 0.78, reach * 0.22);
    const umbraMat = this.umbra.material;
    if (umbraMat instanceof MeshBasicMaterial) umbraMat.opacity = 0.82 * this.solarCover;
    this.umbra.visible = this.solarCover > 0.08;

    this.lunarShadow.position.copy(this.moonMesh.position);
    this.lunarShadow.scale.setScalar(this.moonMesh.scale.x * 1.45);
    const lunarMat = this.lunarShadow.material;
    if (lunarMat instanceof MeshBasicMaterial) lunarMat.opacity = 0.62 * this.lunarCover;
    this.lunarShadow.visible = this.lunarCover > 0.08;
    this.moonMat.color.setHex(this.lunarCover > 0.35 ? 0x9f1239 : 0xd6d3d1);
    this.moonMat.emissive.setHex(this.lunarCover > 0.2 ? 0x7f1d1d : 0x000000);
    this.moonMat.emissiveIntensity = this.lunarCover * 0.85;
    this.moonLight.intensity = 2.2 * (1 - 0.94 * this.lunarCover);
  }

  private stepDebris(dt: number): void {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const burst = this.debris[i];
      burst.life += dt;
      const planet = this.planets.get(burst.planetId);
      const center = planet?.mesh.position;
      const attr = burst.points.geometry.getAttribute("position") as BufferAttribute;
      for (let p = 0; p < burst.positions.length; p += 3) {
        if (center) {
          const dx = center.x - burst.positions[p];
          const dy = center.y - burst.positions[p + 1];
          const dz = center.z - burst.positions[p + 2];
          const d2 = dx * dx + dy * dy + dz * dz;
          const pull = 8 / Math.max(d2, 0.4);
          burst.velocities[p] += dx * pull * dt;
          burst.velocities[p + 1] += dy * pull * dt;
          burst.velocities[p + 2] += dz * pull * dt;
        }
        burst.positions[p] += burst.velocities[p] * dt;
        burst.positions[p + 1] += burst.velocities[p + 1] * dt;
        burst.positions[p + 2] += burst.velocities[p + 2] * dt;
        attr.setXYZ(p / 3, burst.positions[p], burst.positions[p + 1], burst.positions[p + 2]);
      }
      attr.needsUpdate = true;
      const mat = burst.points.material as PointsMaterial;
      mat.opacity = Math.max(0, 1 - burst.life / burst.fade);
      mat.transparent = true;
      if (burst.life >= burst.fade) {
        this.scene.remove(burst.points);
        burst.points.geometry.dispose();
        mat.dispose();
        this.debris.splice(i, 1);
      }
    }
  }

  update(dt: number): void {
    const playing = this.acts.busy || this.debris.length > 0 || this.eclipse !== null;
    const target = this.paused ? 0 : Math.min(this.timeScale, playing ? 4 : 100);
    const follow = 1 - Math.exp(-Math.max(dt, 0) / 0.35);
    this.appliedScale += (target - this.appliedScale) * Math.min(1, follow);
    const dayStep = this.paused || this.acts.rewinding ? 0 : dt * this.appliedScale * 8;
    this.simDays += dayStep;

    for (const planet of this.planets.values()) {
      planet.pull.set(0, 0, 0);
      planet.spin += planet.def.spinRadPerDay * dayStep;
      planet.mesh.rotation.y = planet.spin;
      if (planet.clouds) planet.clouds.rotation.y = planet.spin * 0.2;
      this.syncPlanet(planet);
    }
    this.stepMoon(dt);
    this.applyEclipse();
    this.stepDebris(dt);
    this.particles.update(dt);
    this.acts.step(dt);
    this.updatePreview();
  }

  private applyEclipse(): void {
    const occulters = [...this.planets.values()].map((planet) => ({
      pos: planet.au,
      radiusAu: bodyRadiusAu(planet.def.radiusKm),
      alive: !planet.destroyed,
    }));
    for (const planet of this.planets.values()) {
      if (planet.destroyed) {
        planet.light.intensity = 0;
        continue;
      }
      const eclipsed = isEclipsed(planet.au, occulters.filter((item) => item.pos !== planet.au));
      let intensity = 3.4 * earthExposure(planet.auDistance) * (eclipsed ? 0.08 : 1);
      if (planet.id === "earth") intensity *= 1 - 0.93 * this.solarCover;
      planet.light.intensity = intensity;
    }
  }

  layoutLabels(camera: PerspectiveCamera, width: number, height: number): void {
    const sunWorld = this.sun.getWorldPosition(this.ndc);
    sunWorld.project(camera);
    const sunEl = this.labels.root.querySelector("[data-role='sun']");
    if (sunEl instanceof HTMLDivElement) {
      if (sunWorld.z > 1) sunEl.style.opacity = "0";
      else {
        this.labels.place(
          sunEl,
          (sunWorld.x * 0.5 + 0.5) * width,
          (-sunWorld.y * 0.5 + 0.5) * height,
          0.9,
          false,
        );
      }
    }

    const vFov = (camera.fov * Math.PI) / 180;
    for (const [id, planet] of this.planets) {
      const dist = Math.max(camera.position.distanceTo(planet.mesh.position), 0.5);
      const worldPerPx = (2 * Math.tan(vFov / 2) * dist) / Math.max(height, 1);
      const minDiameter = 3.2 * worldPerPx;
      const scale = Math.max(1, minDiameter / (planet.radius * 2));
      planet.layoutScale = scale;
      planet.mesh.scale.setScalar(scale * planet.visualScale);
      const animating = this.acts.isAnimating(id);
      if (planet.destroyed && !animating) {
        planet.mesh.visible = false;
        planet.label.style.opacity = "0";
        continue;
      }
      const angular = (planet.radius * scale) / dist;
      if (planet.atmoFade) {
        planet.atmoFade.value = angular < 0.008 ? 0 : angular < 0.03 ? (angular - 0.008) / 0.022 : 1;
      }
      const selected = this.selectedIds.has(id);
      planet.label.textContent = selected
        ? `${planet.def.nameKo}\n${planet.auDistance.toFixed(2)} AU · ${Math.round(planet.def.radiusKm).toLocaleString("ko-KR")} km`
        : planet.def.nameKo;
      let opacity = 1;
      if (!selected && angular > 0.11) opacity = 0;
      else if (!selected && angular > 0.055) opacity = 1 - (angular - 0.055) / 0.055;
      const ndc = planet.mesh.getWorldPosition(this.ndc);
      ndc.project(camera);
      if (ndc.z > 1) opacity = 0;
      this.labels.place(
        planet.label,
        (ndc.x * 0.5 + 0.5) * width,
        (-ndc.y * 0.5 + 0.5) * height,
        opacity,
        selected,
      );
    }

    if (!this.moonMesh.visible) this.moonLabel.style.opacity = "0";
    else {
      const moonNdc = this.moonMesh.getWorldPosition(this.ndc);
      moonNdc.project(camera);
      const moonOpacity = moonNdc.z > 1 ? 0 : this.lunarCover > 0.35 || this.solarCover > 0.35 ? 1 : 0.85;
      this.labels.place(
        this.moonLabel,
        (moonNdc.x * 0.5 + 0.5) * width,
        (-moonNdc.y * 0.5 + 0.5) * height,
        moonOpacity,
        false,
      );
    }
  }

  listStates(): { id: string; nameKo: string; color: number; destroyed: boolean }[] {
    return PLANETS.map((p) => {
      const runtime = this.planets.get(p.id)!;
      return { id: p.id, nameKo: p.nameKo, color: p.color, destroyed: runtime.destroyed };
    });
  }
}
