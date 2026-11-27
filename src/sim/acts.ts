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
import { Dyn, integrate, resolveContact } from "./physics";

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
  pos: Vector3;
  vel: Vector3;
}

interface HoleClip {
  kind: "hole";
  reverse: boolean;
  planetId: string;
  t: number;
  dur: number;
  hole: Group;
  record: boolean;
  pos: Vector3;
  vel: Vector3;
}

interface LaserClip {
  kind: "laser";
  reverse: boolean;
  planetId: string;
  t: number;
  dur: number;
  beam: Mesh;
  bits: { mesh: Mesh; dir: Vector3; vel: Vector3 }[];
  record: boolean;
  pos: Vector3;
  vel: Vector3;
  struck: boolean;
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

  constructor(
    private readonly scene: Scene,
    private readonly planets: Map<string, T>,
    private readonly history: HistoryStack,
    private readonly particles: ParticleSystem,
    private readonly onHide: (id: string) => void,
    private readonly onShow: (id: string) => void,
    private readonly onSettle: () => void,
    private readonly spawnDebris: (id: string, at: Vector3, momentum: Vector3) => void,
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
    const center = this.orbitalCenter(planet);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const hit = center.clone().addScaledVector(APPROACH, reach);
    const start = center.clone().addScaledVector(APPROACH, 18 + reach);
    const vel = hit.clone().sub(start);
    if (vel.lengthSq() < 1e-6) vel.copy(APPROACH);
    vel.normalize().multiplyScalar(reverse ? -18 : 18);
    this.clip = {
      kind: "meteor",
      reverse,
      planetId,
      fast,
      t: 0,
      dur: 4.2,
      rock,
      eBefore: saved?.eOffset ?? planet.eOffset,
      mBefore: saved?.mOffset ?? planet.mOffset,
      eAfter: planet.eOffset,
      mAfter: planet.mOffset,
      scarIndex: saved?.scarIndex ?? -1,
      pos: reverse ? hit : start,
      vel,
    };
    this.statusHint = reverse ? "운석이 되돌아 나갑니다." : "운석이 날아와 부딪힙니다.";
    if (reverse) this.recallDebris(planetId);
  }

  private stepMeteor(clip: MeteorClip, dt: number): void {
    const planet = this.body(clip.planetId);
    if (!planet) {
      this.disposeGroup(clip.rock);
      this.finish("행성을 찾지 못했습니다.");
      return;
    }
    clip.t += dt;
    const center = this.orbitalCenter(planet);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const rock: Dyn = { pos: clip.pos, vel: clip.vel, radius: Math.max(0.7, reach * 0.34), invMass: 1 };
    const surface: Dyn = { pos: center.clone(), vel: new Vector3(), radius: reach, invMass: 0 };
    let contact = false;
    const steps = 4;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      integrate(rock, new Vector3(), h);
      if (resolveContact(rock, surface, 0.18)) {
        contact = true;
        break;
      }
    }
    clip.rock.position.copy(clip.pos);
    clip.rock.scale.setScalar(Math.max(1.05, reach * 0.62));
    clip.rock.lookAt(clip.pos.clone().add(clip.vel));
    clip.rock.rotateZ(clip.t * 5);
    const flown = clip.vel.length() * clip.t;
    const span = 18 + reach;
    const u = Math.min(1, flown / span);
    if (clip.reverse) {
      planet.eOffset = clip.eAfter + (clip.eBefore - clip.eAfter) * u;
      planet.mOffset = clip.mAfter + (clip.mBefore - clip.mAfter) * u;
      const scar = clip.scarIndex >= 0 ? planet.scars[clip.scarIndex] : undefined;
      if (scar) scar.scale.setScalar(Math.max(0.001, 1 - u));
      if (u < 1 && clip.t < clip.dur) return;
      if (clip.scarIndex >= 0) this.removeScar(planet, clip.scarIndex);
      planet.eOffset = clip.eBefore;
      planet.mOffset = clip.mBefore;
      this.disposeGroup(clip.rock);
      this.finish(clip.fast ? "파편이 모여 운석이 빠져나갔습니다." : "운석이 빠지고 흉터가 사라졌습니다.");
      return;
    }
    if (!contact && clip.t < clip.dur) return;
    const at = clip.pos.clone();
    const momentum = clip.vel.clone();
    this.disposeGroup(clip.rock);
    sfx.playImpact();
    this.particles.spawnExplosion(at, clip.fast ? 0xf97316 : planet.color, clip.fast ? 90 : 40);
    if (clip.fast) {
      this.spawnDebris(planet.id, at, momentum);
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
    this.spawnDebris(planet.id, at, momentum);
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
      this.recallDebris(planetId);
    }
    const center = this.orbitalCenter(planet);
    const holePos = center.clone().addScaledVector(sideOf(center, this.side), 7);
    const vel = center.clone().sub(holePos);
    if (vel.lengthSq() < 1e-6) vel.set(1, 0, 0);
    vel.normalize().multiplyScalar(reverse ? 5.5 : 0);
    this.clip = {
      kind: "hole",
      reverse,
      planetId,
      t: 0,
      dur,
      hole,
      record,
      pos: reverse ? holePos : center.clone(),
      vel,
    };
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
    const center = this.orbitalCenter(planet);
    const holePos = center.clone().addScaledVector(sideOf(center, this.side), 7);
    clip.hole.position.copy(holePos);
    clip.hole.rotation.y += dt * 1.6;
    const acc = holePos.clone().sub(clip.pos);
    const dist = Math.max(acc.length(), 0.55);
    acc.multiplyScalar((clip.reverse ? -22 : 42) / (dist * dist));
    const body: Dyn = {
      pos: clip.pos,
      vel: clip.vel,
      radius: Math.max(0.45, planet.radius * Math.max(planet.layoutScale, 0.35) * 0.22),
      invMass: 1,
    };
    const mouth: Dyn = { pos: holePos, vel: new Vector3(), radius: 1.2, invMass: 0 };
    let contact = false;
    const h = dt / 4;
    for (let i = 0; i < 4; i++) {
      integrate(body, acc, h);
      if (resolveContact(body, mouth, 0.05)) contact = true;
    }
    planet.pull.copy(clip.pos).sub(center);
    const gap = clip.pos.distanceTo(holePos);
    planet.visualScale = Math.max(0.04, Math.min(1, gap / 7));
    planet.mesh.visible = true;
    planet.mesh.rotation.y += dt * (2 + clip.vel.length() * 0.15);
    const done = clip.reverse ? gap > 6.4 || clip.t >= clip.dur + 1.2 : contact || clip.t >= clip.dur + 1.4;
    if (!done) return;
    this.disposeGroup(clip.hole);
    planet.pull.set(0, 0, 0);
    if (clip.reverse) {
      this.markWhole(planet);
      if (clip.record) this.history.push({ kind: "restore", planetId: planet.id, act: "blackhole" });
      this.finish("블랙홀이 행성을 놓았습니다.");
      return;
    }
    this.markGone(planet, "blackhole");
    const inward = holePos.clone().sub(center);
    if (inward.lengthSq() < 1e-6) inward.set(1, 0, 0);
    this.spawnDebris(planet.id, holePos, inward.normalize().multiplyScalar(8));
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
    const bits: { mesh: Mesh; dir: Vector3; vel: Vector3 }[] = [];
    for (let i = 0; i < 10; i++) {
      const dir = new Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize();
      const mesh = new Mesh(
        new SphereGeometry(0.14, 8, 6),
        new MeshBasicMaterial({ color: planet.color }),
      );
      mesh.visible = false;
      this.scene.add(mesh);
      bits.push({ mesh, dir, vel: new Vector3() });
    }
    if (reverse) {
      planet.destroyed = false;
      planet.mesh.visible = true;
      planet.visualScale = 0.04;
      planet.mesh.scale.multiplyScalar(0.04);
      this.onShow(planet.id);
      this.recallDebris(planetId);
    }
    const center = this.orbitalCenter(planet);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const from = center.clone();
    from.y += 16 + reach;
    const to = center.clone();
    to.y += reach;
    const vel = to.clone().sub(from);
    if (vel.lengthSq() < 1e-6) vel.set(0, -1, 0);
    vel.normalize().multiplyScalar(reverse ? -26 : 26);
    if (reverse) {
      for (const bit of bits) {
        bit.mesh.position.copy(to).addScaledVector(bit.dir, 5);
        bit.mesh.visible = true;
        bit.vel.copy(bit.dir).multiplyScalar(-7);
      }
    }
    this.clip = {
      kind: "laser",
      reverse,
      planetId,
      t: 0,
      dur,
      beam,
      bits,
      record,
      pos: reverse ? to : from,
      vel,
      struck: reverse,
    };
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
    const center = this.orbitalCenter(planet);
    const reach = planet.radius * Math.max(planet.layoutScale, 0.35);
    const from = this.from.copy(center);
    from.y += 16 + reach;
    const surface: Dyn = { pos: center.clone(), vel: new Vector3(), radius: reach, invMass: 0 };
    const bolt: Dyn = { pos: clip.pos, vel: clip.vel, radius: 0.35, invMass: 1 };
    if (!clip.struck) {
      const h = dt / 4;
      for (let i = 0; i < 4; i++) {
        integrate(bolt, new Vector3(), h);
        if (resolveContact(bolt, surface, 0.05)) {
          clip.struck = true;
          for (const bit of clip.bits) {
            bit.mesh.position.copy(clip.pos);
            bit.mesh.visible = true;
            bit.vel.copy(clip.vel).multiplyScalar(0.45).addScaledVector(bit.dir, 4 + Math.random() * 3);
            if (clip.reverse) bit.vel.multiplyScalar(-1);
          }
          break;
        }
      }
    }
    const beamTip = clip.struck ? center : clip.pos;
    this.aimBeam(clip.beam, from, beamTip, clip.struck || clip.reverse ? 1 : Math.min(1, clip.t / 0.25));
    if (clip.struck) {
      for (const bit of clip.bits) {
        const spec: Dyn = { pos: bit.mesh.position, vel: bit.vel, radius: 0.14, invMass: 1 };
        integrate(spec, new Vector3(), dt);
        bit.mesh.visible = true;
      }
    }
    const travel = Math.min(1, clip.t / clip.dur);
    planet.visualScale = clip.reverse
      ? Math.max(0.04, clip.struck ? travel : 0.04)
      : Math.max(0.04, clip.struck ? 1 - 0.96 * Math.min(1, (clip.t / clip.dur)) : 1);
    planet.mesh.visible = true;
    planet.material.emissive.setHex(0xf8fafc);
    planet.material.emissiveIntensity = (clip.struck ? 1 : 0.35) * 1.5;
    if (clip.reverse) {
      if (clip.t < clip.dur) return;
    } else if (!clip.struck || clip.t < 0.95) {
      if (!clip.struck && clip.t > clip.dur) {
        clip.pos.copy(center);
        clip.struck = true;
      }
      return;
    }
    const momentum = clip.vel.clone();
    this.disposeMesh(clip.beam);
    for (const bit of clip.bits) this.disposeMesh(bit.mesh);
    if (clip.reverse) {
      this.markWhole(planet);
      if (clip.record) this.history.push({ kind: "restore", planetId: planet.id, act: "laser" });
      this.finish("광선이 걷히고 행성이 돌아왔습니다.");
      return;
    }
    this.spawnDebris(planet.id, center, momentum);
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
