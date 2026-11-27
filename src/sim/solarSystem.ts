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
import { ParticleSystem, createMeteorMesh } from "../effects/particles";
import { LabelLayer } from "../render/labels";
import { createPlanetLook, createSunCorona, createSunMaterial } from "../render/surfaces";
import type { AtmoFade } from "../render/surfaces";
import { HistoryStack } from "./history";
import type { BodySnapshot, ScarPoint } from "./history";
import {
  MU_SUN,
  bodyRadiusAu,
  earthExposure,
  isEclipsed,
  sphereOfInfluence,
  writeOrbitTrail,
  writePlanetAu,
  writePlanetScene,
} from "./kepler";
import { orbitRadiusSceneUnits } from "../data/planets";

export type ToolMode = "select" | "destroy" | "impact";

const TRAIL_STEPS = 128;
const APPROACH = new Vector3(-0.72, 0.42, -0.56).normalize();

interface PlanetRuntime {
  def: PlanetDefinition;
  group: Group;
  mesh: Mesh;
  material: MeshStandardMaterial;
  orbitLine: Line;
  orbitPositions: Float32Array;
  orbitColors: Float32Array;
  light: DirectionalLight;
  atmosphere: Mesh | null;
  atmoFade: AtmoFade | null;
  clouds: Mesh | null;
  destroyed: boolean;
  epoch: number;
  eOffset: number;
  mOffset: number;
  spin: number;
  scars: Mesh[];
  label: HTMLDivElement;
  radius: number;
  nightEmissive: number;
  nightLevel: number;
  au: Vector3;
  auDistance: number;
}

interface MeteorFlight {
  pos: Vector3;
  vel: Vector3;
  mesh: Group;
  fast: boolean;
  planetId: string;
}

interface DebrisBurst {
  positions: Float32Array;
  velocities: Float32Array;
  points: Points;
  life: number;
  planetId: string;
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

  private appliedScale = 1;
  private meteor: MeteorFlight | null = null;
  private readonly debris: DebrisBurst[] = [];
  private focusId: string | null = null;
  private readonly previewHit: Mesh;
  private readonly previewLine: Line;
  private readonly labels: LabelLayer;
  private readonly auScratch = new Vector3();
  private readonly prevAu = new Vector3();
  private readonly ndc = new Vector3();

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

    PLANETS.forEach((def, index) => this.createPlanet(def, index));
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
      epoch: (def.meanAnomalyDeg * Math.PI) / 180,
      eOffset: 0,
      mOffset: 0,
      spin: 0,
      scars: [],
      label: this.labels.create(def.nameKo),
      radius: look.radius,
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

  destroyPlanet(planetId: string, recordHistory = true): void {
    const planet = this.planets.get(planetId);
    if (!planet || planet.destroyed) return;
    planet.destroyed = true;
    planet.mesh.visible = false;
    planet.light.intensity = 0;
    (planet.orbitLine.material as LineBasicMaterial).opacity = 0.12;
    planet.label.style.opacity = "0";
    this.selectedIds.delete(planetId);
    if (recordHistory) {
      this.history.push({ kind: "destroy", planetId });
      sfx.playDestroy();
    }
    this.updateSelectionVisuals();
  }

  restorePlanet(planetId: string, recordHistory = true): void {
    const planet = this.planets.get(planetId);
    if (!planet || !planet.destroyed) return;
    planet.destroyed = false;
    planet.mesh.visible = true;
    (planet.orbitLine.material as LineBasicMaterial).opacity = 0.95;
    if (recordHistory) this.history.push({ kind: "restore", planetId });
    this.updateSelectionVisuals();
  }

  destroySelected(): void {
    for (const id of [...this.selectedIds]) this.destroyPlanet(id);
  }

  restoreOne(): void {
    const destroyed = PLANETS.map((p) => p.id).filter((id) => this.planets.get(id)?.destroyed);
    if (destroyed.length === 0) return;
    this.restorePlanet(destroyed[destroyed.length - 1]);
  }

  undo(): void {
    const action = this.history.pop();
    if (!action) return;
    if (action.kind === "destroy") this.restorePlanet(action.planetId, false);
    else if (action.kind === "restore") this.destroyPlanet(action.planetId, false);
    else if (action.kind === "impact") {
      const planet = this.planets.get(action.planetId);
      if (!planet) return;
      planet.eOffset = action.eOffset;
      planet.mOffset = action.mOffset;
      if (action.scarIndex >= 0) this.removeScar(planet, action.scarIndex);
    } else if (action.kind === "reset") {
      this.simDays = action.simDays;
      for (const snap of action.bodies) this.applySnapshot(snap);
      for (const id of this.planets.keys()) {
        const destroyed = action.destroyedIds.includes(id);
        const planet = this.planets.get(id);
        if (!planet) continue;
        if (destroyed) this.destroyPlanet(id, false);
        else this.restorePlanet(id, false);
      }
      this.syncAll();
    }
  }

  resetAll(recordHistory = true): void {
    const destroyedIds = [...this.planets.entries()]
      .filter(([, planet]) => planet.destroyed)
      .map(([id]) => id);
    const bodies = [...this.planets.values()].map((planet) => this.snapshot(planet));
    const priorDays = this.simDays;
    for (const id of this.planets.keys()) this.restorePlanet(id, false);
    this.selectedIds.clear();
    this.simDays = 0;
    if (this.meteor) {
      this.scene.remove(this.meteor.mesh);
      this.meteor = null;
    }
    for (const burst of this.debris) {
      this.scene.remove(burst.points);
      burst.points.geometry.dispose();
      (burst.points.material as PointsMaterial).dispose();
    }
    this.debris.length = 0;
    for (const planet of this.planets.values()) {
      planet.epoch = Math.random() * Math.PI * 2;
      planet.eOffset = 0;
      planet.mOffset = 0;
      planet.spin = 0;
      this.clearScars(planet);
    }
    this.syncAll();
    if (recordHistory) {
      this.history.push({ kind: "reset", destroyedIds, simDays: priorDays, bodies });
    }
    this.updateSelectionVisuals();
  }

  impactSelected(fast = false): void {
    const ids = [...this.selectedIds].filter((id) => {
      const planet = this.planets.get(id);
      return planet && !planet.destroyed;
    });
    const target = ids[0];
    if (!target || this.meteor) return;
    sfx.prime();
    this.launchMeteor(target, fast);
  }

  private launchMeteor(planetId: string, fast: boolean): void {
    const planet = this.planets.get(planetId);
    if (!planet || planet.destroyed) return;
    writePlanetAu(
      planet.def,
      planet.epoch +
        ((2 * Math.PI) / planet.def.orbitalPeriodDays) * this.simDays +
        planet.mOffset,
      planet.eOffset,
      this.auScratch,
    );
    const pos = this.auScratch.clone().addScaledVector(APPROACH, 0.12);
    const vel = APPROACH.clone().multiplyScalar(fast ? -0.045 : -0.011);
    const mesh = createMeteorMesh();
    this.scene.add(mesh);
    this.meteor = { pos, vel, mesh, fast, planetId };
  }

  private onMeteorHit(flight: MeteorFlight): void {
    const planet = this.planets.get(flight.planetId);
    this.scene.remove(flight.mesh);
    this.meteor = null;
    if (!planet || planet.destroyed) return;
    sfx.playImpact();
    const hit = planet.mesh.getWorldPosition(new Vector3());
    this.particles.spawnExplosion(hit, flight.fast ? 0xf97316 : planet.def.color, flight.fast ? 80 : 36);
    if (flight.fast) {
      this.spawnDebris(planet, hit);
      return;
    }
    const beforeE = planet.eOffset;
    const beforeM = planet.mOffset;
    planet.eOffset += 0.012;
    planet.mOffset += 0.08;
    const scarIndex = this.addScar(planet);
    this.history.push({
      kind: "impact",
      planetId: planet.def.id,
      eOffset: beforeE,
      mOffset: beforeM,
      scarIndex,
    });
  }

  private addScar(planet: PlanetRuntime): number {
    const scar = new Mesh(
      new SphereGeometry(planet.radius * 0.07, 10, 8),
      new MeshStandardMaterial({ color: 0x1a100c, roughness: 1, metalness: 0 }),
    );
    const point = planet.mesh.position.clone().addScaledVector(APPROACH, planet.radius);
    planet.mesh.worldToLocal(point);
    if (point.lengthSq() > 1e-8) point.normalize().multiplyScalar(planet.radius * 0.96);
    scar.position.copy(point);
    scar.layers.mask = planet.mesh.layers.mask;
    planet.mesh.add(scar);
    planet.scars.push(scar);
    return planet.scars.length - 1;
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

  private spawnDebris(planet: PlanetRuntime, origin: Vector3): void {
    const count = 16;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const speed = 3.5 + Math.random() * 6;
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      velocities[i * 3] = dir.x * speed + APPROACH.x * -2;
      velocities[i * 3 + 1] = dir.y * speed + APPROACH.y * -2;
      velocities[i * 3 + 2] = dir.z * speed + APPROACH.z * -2;
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
    this.debris.push({ positions, velocities, points, life: 0, planetId: planet.def.id });
  }

  private snapshot(planet: PlanetRuntime): BodySnapshot {
    return {
      id: planet.def.id,
      epoch: planet.epoch,
      eOffset: planet.eOffset,
      mOffset: planet.mOffset,
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
    const show = this.mode === "impact" && !this.meteor && id !== undefined;
    this.previewHit.visible = show;
    this.previewLine.visible = show;
    if (!show || !id) return;
    const planet = this.planets.get(id);
    if (!planet) return;
    const center = planet.mesh.position;
    const reach = planet.radius * planet.mesh.scale.x;
    const hit = center.clone().addScaledVector(APPROACH, -reach);
    const start = center.clone().addScaledVector(APPROACH, 14 + reach);
    this.previewHit.position.copy(hit);
    const attr = this.previewLine.geometry.getAttribute("position") as BufferAttribute;
    attr.setXYZ(0, start.x, start.y, start.z);
    attr.setXYZ(1, hit.x, hit.y, hit.z);
    attr.needsUpdate = true;
    this.previewLine.geometry.computeBoundingSphere();
  }

  private stepMeteor(dayStep: number): void {
    const flight = this.meteor;
    if (!flight || dayStep <= 0) return;
    const planet = this.planets.get(flight.planetId);
    if (!planet || planet.destroyed) {
      this.scene.remove(flight.mesh);
      this.meteor = null;
      return;
    }
    const limit = Math.max(bodyRadiusAu(planet.def.radiusKm) * 40, 2.5e-4);
    const soi = sphereOfInfluence(planet.def);
    let left = dayStep;
    let guard = 0;
    while (left > 1e-8 && guard < 400) {
      const dist = flight.pos.distanceTo(planet.au);
      const step = Math.min(left, dist > soi ? 0.04 : 0.004);
      this.prevAu.copy(flight.pos);
      this.integrateMeteor(flight, planet, step, dist < soi);
      if (this.segmentHits(this.prevAu, flight.pos, planet.au, limit)) {
        this.onMeteorHit(flight);
        return;
      }
      left -= step;
      guard += 1;
    }
    const au = flight.pos.length();
    flight.mesh.position.copy(flight.pos);
    if (au > 1e-8) {
      flight.mesh.position.multiplyScalar(orbitRadiusSceneUnits(au) / au);
    }
  }

  private integrateMeteor(
    flight: MeteorFlight,
    planet: PlanetRuntime,
    step: number,
    inInfluence: boolean,
  ): void {
    const acc = this.gravityAt(flight.pos, inInfluence ? planet : null);
    flight.vel.addScaledVector(acc, step);
    flight.pos.addScaledVector(flight.vel, step);
  }

  private gravityAt(pos: Vector3, planet: PlanetRuntime | null): Vector3 {
    const r2 = Math.max(pos.lengthSq(), 1e-6);
    const acc = pos.clone().multiplyScalar(-MU_SUN / (r2 * Math.sqrt(r2)));
    if (!planet) return acc;
    const dx = pos.x - planet.au.x;
    const dy = pos.y - planet.au.y;
    const dz = pos.z - planet.au.z;
    const d2 = Math.max(dx * dx + dy * dy + dz * dz, 1e-12);
    const inv = -MU_SUN * planet.def.massSun / (d2 * Math.sqrt(d2));
    acc.x += dx * inv;
    acc.y += dy * inv;
    acc.z += dz * inv;
    return acc;
  }

  private segmentHits(a: Vector3, b: Vector3, center: Vector3, limit: number): boolean {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const ab2 = abx * abx + aby * aby + abz * abz;
    const acx = center.x - a.x;
    const acy = center.y - a.y;
    const acz = center.z - a.z;
    let t = ab2 < 1e-18 ? 0 : (acx * abx + acy * aby + acz * abz) / ab2;
    t = Math.min(1, Math.max(0, t));
    const dx = a.x + abx * t - center.x;
    const dy = a.y + aby * t - center.y;
    const dz = a.z + abz * t - center.z;
    return dx * dx + dy * dy + dz * dz <= limit * limit;
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
      mat.opacity = Math.max(0, 1 - burst.life / 1.5);
      mat.transparent = true;
      if (burst.life >= 1.5) {
        this.scene.remove(burst.points);
        burst.points.geometry.dispose();
        mat.dispose();
        this.debris.splice(i, 1);
      }
    }
  }

  update(dt: number): void {
    const capped = this.meteor !== null || this.debris.length > 0;
    const target = this.paused ? 0 : Math.min(this.timeScale, capped ? 4 : 100);
    const follow = 1 - Math.exp(-Math.max(dt, 0) / 0.35);
    this.appliedScale += (target - this.appliedScale) * Math.min(1, follow);
    const dayStep = dt * this.appliedScale * 8;
    this.simDays += dayStep;

    for (const planet of this.planets.values()) {
      planet.spin += planet.def.spinRadPerDay * dayStep;
      planet.mesh.rotation.y = planet.spin;
      if (planet.clouds) planet.clouds.rotation.y = planet.spin * 0.2;
      this.syncPlanet(planet);
    }
    this.applyEclipse();
    this.stepMeteor(dayStep);
    this.stepDebris(dt);
    this.particles.update(dt);
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
      planet.light.intensity = 3.4 * earthExposure(planet.auDistance) * (eclipsed ? 0.08 : 1);
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
      if (planet.destroyed) {
        planet.label.style.opacity = "0";
        continue;
      }
      const dist = Math.max(camera.position.distanceTo(planet.mesh.position), 0.5);
      const worldPerPx = (2 * Math.tan(vFov / 2) * dist) / Math.max(height, 1);
      const minDiameter = 3.2 * worldPerPx;
      const scale = Math.max(1, minDiameter / (planet.radius * 2));
      planet.mesh.scale.setScalar(scale);
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
  }

  getHudText(): string {
    const destroyedCount = [...this.planets.values()].filter((p) => p.destroyed).length;
    const sel = this.selectedIds.size > 0 ? [...this.selectedIds].join(", ") : "없음";
    const scale = this.paused ? "일시정지" : `${this.appliedScale.toFixed(2)}×`;
    return [
      `시뮬레이션 일수: ${this.simDays.toFixed(0)}`,
      `선택: ${sel}`,
      `파괴됨: ${destroyedCount}/${PLANETS.length}`,
      `시간 배율: ${scale}`,
    ].join(" · ");
  }

  listStates(): { id: string; nameKo: string; color: number; destroyed: boolean }[] {
    return PLANETS.map((p) => {
      const runtime = this.planets.get(p.id)!;
      return { id: p.id, nameKo: p.nameKo, color: p.color, destroyed: runtime.destroyed };
    });
  }
}
