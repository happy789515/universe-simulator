import {
  CylinderGeometry,
  DoubleSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three/webgpu";
import type { Scene } from "three/webgpu";
import { sfx } from "../audio/sfx";
import { ParticleSystem } from "../effects/particles";
import { DeathAct, HistoryStack } from "./history";

export const APPROACH = new Vector3(-0.72, 0.42, -0.56).normalize();

const UP = new Vector3(0, 1, 0);
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

export interface ActBody {
  id: string;
  destroyed: boolean;
  death: DeathAct | null;
  radius: number;
  color: number;
  mesh: Mesh;
  material: MeshStandardMaterial;
  visualScale: number;
  pull: Vector3;
  layoutScale: number;
  eOffset: number;
  mOffset: number;
  scars: Mesh[];
}

export type ActMode = "select" | "meteor" | "blackhole" | "laser";

interface MeteorClip {
  kind: "meteor";
  reverse: boolean;
  planetId: string;
  fast: boolean;
  t: number;
  dur: number;
  rock: Group;
  eBefore: number;
  mBefore: number;
  eAfter: number;
  mAfter: number;
  scarIndex: number;
}

interface HoleClip {
  kind: "hole";
  reverse: boolean;
  planetId: string;
  t: number;
  dur: number;
  hole: Group;
  record: boolean;
}

interface LaserClip {
  kind: "laser";
  reverse: boolean;
  planetId: string;
  t: number;
  dur: number;
  beam: Mesh;
  bits: { mesh: Mesh; dir: Vector3 }[];
  record: boolean;
}

interface RewindClip {
  kind: "rewind";
  t: number;
  dur: number;
  onFrame: (u: number) => void;
  onDone: () => void;
}

type Clip = MeteorClip | HoleClip | LaserClip | RewindClip;

function smooth(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
}

function sideOf(center: Vector3, out: Vector3): Vector3 {
  out.copy(center);
  if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
  else out.normalize();
  const side = new Vector3().crossVectors(out, Y_AXIS);
  if (side.lengthSq() < 1e-6) side.crossVectors(out, X_AXIS);
  return side.normalize();
}

export class ActPlayer<T extends ActBody> {
  statusHint = "";
  resultHint = "";
  readonly deathOrder: string[] = [];

  private clip: Clip | null = null;
  private readonly queue: Array<() => void> = [];
  private readonly side = new Vector3();
  private readonly center = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly planets: Map<string, T>,
    private readonly history: HistoryStack,
    private readonly particles: ParticleSystem,
    private readonly onHide: (id: string) => void,
    private readonly onShow: (id: string) => void,
    private readonly onSettle: () => void,
    private readonly spawnDebris: (id: string, at: Vector3) => void,
    private readonly recallDebris: (id: string) => void,
  ) {}

  get busy(): boolean {
    return this.clip !== null || this.queue.length > 0;
  }

  get rewinding(): boolean {
    return this.clip?.kind === "rewind";
  }

  isAnimating(id: string): boolean {
    const clip = this.clip;
    return clip !== null && clip.kind !== "rewind" && clip.planetId === id;
  }

  clearResult(): void {
    this.resultHint = "";
  }

  launch(mode: ActMode, planetId: string, fast: boolean): void {
    if (mode === "meteor") this.enqueue(() => this.startMeteor(planetId, fast, false));
    else if (mode === "blackhole") this.enqueue(() => this.startHole(planetId, false, true, 2.15));
    else if (mode === "laser") this.enqueue(() => this.startLaser(planetId, false, true, 1.9));
    else this.resultHint = "파괴 도구를 먼저 고르세요.";
  }

  playReverse(planetId: string, act: DeathAct, record: boolean, dur?: number): void {
    this.enqueue(() => {
      if (act === "blackhole") this.startHole(planetId, true, record, dur ?? 2.05);
      else this.startLaser(planetId, true, record, dur ?? 1.8);
    });
  }

  playForward(planetId: string, act: DeathAct, record: boolean, dur?: number): void {
    this.enqueue(() => {
      if (act === "blackhole") this.startHole(planetId, false, record, dur ?? 2.05);
      else this.startLaser(planetId, false, record, dur ?? 1.8);
    });
  }

  playImpactReverse(action: {
    planetId: string;
    eOffset: number;
    mOffset: number;
    scarIndex: number;
    fast: boolean;
  }): void {
    this.enqueue(() => {
      this.startMeteor(action.planetId, action.fast, true, action);
    });
  }

  playRewind(dur: number, onFrame: (u: number) => void, onDone: () => void): void {
    this.enqueue(() => {
      this.clip = { kind: "rewind", t: 0, dur, onFrame, onDone };
      this.statusHint = "궤도를 되감는 중입니다.";
    });
  }

  step(dt: number): void {
    const clip = this.clip;
    if (!clip) return;
    if (clip.kind === "meteor") this.stepMeteor(clip, dt);
    else if (clip.kind === "hole") this.stepHole(clip, dt);
    else if (clip.kind === "laser") this.stepLaser(clip, dt);
    else this.stepRewind(clip, dt);
    this.applyPull();
  }

  private enqueue(start: () => void): void {
    this.queue.push(start);
    this.pump();
  }

  private pump(): void {
    if (this.clip || this.queue.length === 0) return;
    const start = this.queue.shift();
    start?.();
  }

  private finish(message: string): void {
    this.clip = null;
    this.statusHint = "";
    this.resultHint = message;
    this.onSettle();
    this.pump();
  }

  private body(id: string): T | undefined {
    return this.planets.get(id);
  }

  private markGone(planet: T, act: DeathAct): void {
    planet.destroyed = true;
    planet.death = act;
    planet.visualScale = 1;
    planet.pull.set(0, 0, 0);
    planet.mesh.visible = false;
    if (!this.deathOrder.includes(planet.id)) this.deathOrder.push(planet.id);
    this.onHide(planet.id);
  }

  private markWhole(planet: T): void {
    planet.destroyed = false;
    planet.death = null;
    planet.visualScale = 1;
    planet.pull.set(0, 0, 0);
    planet.mesh.visible = true;
    const index = this.deathOrder.indexOf(planet.id);
    if (index >= 0) this.deathOrder.splice(index, 1);
    this.onShow(planet.id);
  }

  private orbitalCenter(planet: T): Vector3 {
    return this.center.copy(planet.mesh.position).sub(planet.pull);
  }

  private startMeteor(
    planetId: string,
    fast: boolean,
    reverse: boolean,
    saved?: { eOffset: number; mOffset: number; scarIndex: number },
  ): void {
    const planet = this.body(planetId);
    if (!planet || (reverse && planet.destroyed)) {
      this.finish("행성을 찾지 못했습니다.");
      return;
    }
    const rock = this.createRock();
    this.scene.add(rock);
    this.clip = {
      kind: "meteor",
      reverse,
      planetId,
      fast,
      t: 0,
      dur: reverse ? 1.35 : 1.6,
      rock,
      eBefore: saved?.eOffset ?? planet.eOffset,
      mBefore: saved?.mOffset ?? planet.mOffset,
      eAfter: planet.eOffset,
      mAfter: planet.mOffset,
      scarIndex: saved?.scarIndex ?? -1,
    };
    this.statusHint = reverse ? "운석이 되돌아 나갑니다." : "운석이 날아와 부딪힙니다.";
    if (reverse && fast) this.recallDebris(planetId);
  }

  private stepMeteor(clip: MeteorClip, dt: number): void {
    const planet = this.body(clip.planetId);
    if (!planet) {
      this.disposeGroup(clip.rock);
      this.finish("행성을 찾지 못했습니다.");
      return;
    }
    clip.t += dt;
    const u = Math.min(1, clip.t / clip.dur);
    const eased = smooth(u);
    const travel = clip.reverse ? 1 - eased : eased;
    const center = this.orbitalCenter(planet);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const hit = this.to.copy(center).addScaledVector(APPROACH, reach);
    const start = this.from.copy(center).addScaledVector(APPROACH, 18 + reach);
    clip.rock.position.lerpVectors(start, hit, travel);
    clip.rock.scale.setScalar(Math.max(1.05, reach * 0.62));
    clip.rock.lookAt(hit);
    clip.rock.rotateZ(clip.t * 5);
    if (clip.reverse) {
      planet.eOffset = clip.eAfter + (clip.eBefore - clip.eAfter) * eased;
      planet.mOffset = clip.mAfter + (clip.mBefore - clip.mAfter) * eased;
      const scar = clip.scarIndex >= 0 ? planet.scars[clip.scarIndex] : undefined;
      if (scar) scar.scale.setScalar(Math.max(0.001, 1 - eased));
    }
    if (u < 1) return;
    if (clip.reverse) {
      if (clip.scarIndex >= 0) this.removeScar(planet, clip.scarIndex);
      planet.eOffset = clip.eBefore;
      planet.mOffset = clip.mBefore;
      this.disposeGroup(clip.rock);
      this.finish(clip.fast ? "파편이 모여 운석이 빠져나갔습니다." : "운석이 빠지고 흉터가 사라졌습니다.");
      return;
    }
    const at = hit.clone();
    this.disposeGroup(clip.rock);
    sfx.playImpact();
    this.particles.spawnExplosion(at, clip.fast ? 0xf97316 : planet.color, clip.fast ? 90 : 40);
    if (clip.fast) {
      this.spawnDebris(planet.id, at);
      this.history.push({
        kind: "impact",
        planetId: planet.id,
        eOffset: clip.eBefore,
        mOffset: clip.mBefore,
        scarIndex: -1,
        fast: true,
      });
      this.finish("빠른 충돌: 파편이 흩어집니다.");
      return;
    }
    const scarIndex = this.addScar(planet);
    this.history.push({
      kind: "impact",
      planetId: planet.id,
      eOffset: clip.eBefore,
      mOffset: clip.mBefore,
      scarIndex,
      fast: false,
    });
    this.finish("충돌: 표면에 흉터가 남았습니다.");
  }

  private startHole(planetId: string, reverse: boolean, record: boolean, dur: number): void {
    const planet = this.body(planetId);
    if (!planet || planet.destroyed !== reverse) {
      this.finish(reverse ? "복원할 행성이 없습니다." : "이미 파괴된 행성입니다.");
      return;
    }
    const hole = this.createHole();
    this.scene.add(hole);
    if (reverse) {
      planet.destroyed = false;
      planet.mesh.visible = true;
      planet.visualScale = 0.04;
      planet.mesh.scale.multiplyScalar(0.04);
      this.onShow(planet.id);
    }
    this.clip = { kind: "hole", reverse, planetId, t: 0, dur, hole, record };
    this.statusHint = reverse ? "블랙홀이 행성을 놓아줍니다." : "블랙홀이 행성을 끌어당깁니다.";
  }

  private stepHole(clip: HoleClip, dt: number): void {
    const planet = this.body(clip.planetId);
    if (!planet) {
      this.disposeGroup(clip.hole);
      this.finish("행성을 찾지 못했습니다.");
      return;
    }
    clip.t += dt;
    const eased = smooth(Math.min(1, clip.t / clip.dur));
    const center = this.orbitalCenter(planet);
    const holePos = center.clone().addScaledVector(sideOf(center, this.side), 7);
    clip.hole.position.copy(holePos);
    clip.hole.rotation.y += dt * 1.6;
    const suck = clip.reverse ? 1 - eased : eased;
    planet.pull.copy(holePos).sub(center).multiplyScalar(suck);
    planet.visualScale = Math.max(0.04, 1 - 0.96 * suck);
    planet.mesh.visible = true;
    planet.mesh.rotation.y += dt * 4;
    if (clip.t < clip.dur) return;
    this.disposeGroup(clip.hole);
    planet.pull.set(0, 0, 0);
    if (clip.reverse) {
      this.markWhole(planet);
      if (clip.record) this.history.push({ kind: "restore", planetId: planet.id, act: "blackhole" });
      this.finish("블랙홀이 행성을 놓았습니다.");
      return;
    }
    this.markGone(planet, "blackhole");
    if (clip.record) {
      this.history.push({ kind: "destroy", planetId: planet.id, act: "blackhole" });
      sfx.playDestroy();
    }
    this.finish("블랙홀이 행성을 삼켰습니다.");
  }

  private startLaser(planetId: string, reverse: boolean, record: boolean, dur: number): void {
    const planet = this.body(planetId);
    if (!planet || planet.destroyed !== reverse) {
      this.finish(reverse ? "복원할 행성이 없습니다." : "이미 파괴된 행성입니다.");
      return;
    }
    const beam = new Mesh(
      new CylinderGeometry(0.06, 0.16, 1, 10, 1, true),
      new MeshBasicMaterial({
        color: 0xe0f2fe,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    );
    beam.frustumCulled = false;
    this.scene.add(beam);
    const bits: { mesh: Mesh; dir: Vector3 }[] = [];
    for (let i = 0; i < 10; i++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize();
      const mesh = new Mesh(
        new SphereGeometry(0.14, 8, 6),
        new MeshBasicMaterial({ color: planet.color }),
      );
      mesh.visible = false;
      this.scene.add(mesh);
      bits.push({ mesh, dir });
    }
    if (reverse) {
      planet.destroyed = false;
      planet.mesh.visible = true;
      planet.visualScale = 0.04;
      planet.mesh.scale.multiplyScalar(0.04);
      this.onShow(planet.id);
    }
    this.clip = { kind: "laser", reverse, planetId, t: 0, dur, beam, bits, record };
    this.statusHint = reverse ? "광선이 되감기며 행성이 복원됩니다." : "광선이 행성을 태웁니다.";
  }

  private stepLaser(clip: LaserClip, dt: number): void {
    const planet = this.body(clip.planetId);
    if (!planet) {
      this.disposeMesh(clip.beam);
      for (const bit of clip.bits) this.disposeMesh(bit.mesh);
      this.finish("행성을 찾지 못했습니다.");
      return;
    }
    clip.t += dt;
    const eased = smooth(Math.min(1, clip.t / clip.dur));
    const center = this.orbitalCenter(planet);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const from = this.from.copy(center);
    from.y += 16 + reach;
    const to = this.to.copy(center);
    to.y += reach;
    const beamGrow = clip.reverse ? 1 - eased : Math.min(1, eased / 0.28);
    this.aimBeam(clip.beam, from, to, beamGrow);
    const burn = clip.reverse ? eased : Math.max(0, (eased - 0.18) / 0.82);
    planet.visualScale = clip.reverse ? Math.max(0.04, burn) : Math.max(0.04, 1 - 0.96 * burn);
    planet.mesh.visible = true;
    planet.material.emissive.setHex(0xf8fafc);
    planet.material.emissiveIntensity = (clip.reverse ? 1 - eased : beamGrow) * 1.5;
    for (const bit of clip.bits) {
      const travel = clip.reverse ? 1 - burn : burn;
      bit.mesh.visible = travel > 0.02;
      bit.mesh.position.copy(center).addScaledVector(bit.dir, 0.3 + travel * (3.4 + reach));
    }
    if (clip.t < clip.dur) return;
    this.disposeMesh(clip.beam);
    for (const bit of clip.bits) this.disposeMesh(bit.mesh);
    if (clip.reverse) {
      this.markWhole(planet);
      if (clip.record) this.history.push({ kind: "restore", planetId: planet.id, act: "laser" });
      this.finish("광선이 걷히고 행성이 돌아왔습니다.");
      return;
    }
    this.markGone(planet, "laser");
    if (clip.record) {
      this.history.push({ kind: "destroy", planetId: planet.id, act: "laser" });
      sfx.playDestroy();
    }
    this.finish("광선이 행성을 태워 없앴습니다.");
  }

  private stepRewind(clip: RewindClip, dt: number): void {
    clip.t += dt;
    const u = smooth(Math.min(1, clip.t / clip.dur));
    clip.onFrame(u);
    if (clip.t < clip.dur) return;
    const done = clip.onDone;
    this.clip = null;
    this.statusHint = "";
    done();
    this.pump();
  }

  private aimBeam(beam: Mesh, from: Vector3, to: Vector3, grow: number): void {
    const delta = to.clone().sub(from);
    const len = Math.max(delta.length(), 0.001);
    delta.multiplyScalar(1 / len);
    const shown = Math.max(len * Math.max(grow, 0), 0.001);
    beam.position.copy(from).addScaledVector(delta, shown / 2);
    beam.scale.set(1, shown, 1);
    beam.quaternion.setFromUnitVectors(UP, delta);
    const mat = beam.material;
    if (mat instanceof MeshBasicMaterial) mat.opacity = 0.95 * Math.min(1, grow);
    beam.visible = grow > 0.03;
  }

  private applyPull(): void {
    for (const planet of this.planets.values()) {
      if (planet.pull.lengthSq() > 0) planet.mesh.position.add(planet.pull);
    }
  }

  private createRock(): Group {
    const group = new Group();
    group.frustumCulled = false;
    const mat = new MeshStandardMaterial({ color: 0x7c6a58, roughness: 0.96, metalness: 0.02 });
    const core = new Mesh(new SphereGeometry(0.48, 14, 12), mat);
    core.scale.set(1.15, 0.82, 0.94);
    const chipMat = new MeshStandardMaterial({ color: 0x4b4036, roughness: 1, metalness: 0 });
    const chip = new Mesh(new SphereGeometry(0.2, 8, 6), chipMat);
    chip.position.set(0.32, 0.14, 0.08);
    group.add(core, chip);
    return group;
  }

  private createHole(): Group {
    const group = new Group();
    const dark = new Mesh(new SphereGeometry(0.62, 24, 16), new MeshBasicMaterial({ color: 0x000000 }));
    const ring = new Mesh(
      new TorusGeometry(1.25, 0.09, 10, 48),
      new MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    const disk = new Mesh(
      new RingGeometry(0.72, 1.45, 48),
      new MeshBasicMaterial({
        color: 0xf97316,
        transparent: true,
        opacity: 0.5,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    group.add(dark, ring, disk);
    return group;
  }

  private addScar(planet: T): number {
    const scar = new Mesh(
      new SphereGeometry(planet.radius * 0.09, 10, 8),
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

  private removeScar(planet: T, index: number): void {
    const scar = planet.scars[index];
    if (!scar) return;
    planet.mesh.remove(scar);
    scar.geometry.dispose();
    const mat = scar.material;
    if (mat instanceof Material) mat.dispose();
    planet.scars.splice(index, 1);
  }

  private disposeMesh(mesh: Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) for (const item of mat) item.dispose();
    else mat.dispose();
  }

  private disposeGroup(group: Group): void {
    const seen = new Set<Material>();
    group.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      child.geometry.dispose();
      const mat = child.material;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        item.dispose();
      }
    });
    this.scene.remove(group);
  }
}
