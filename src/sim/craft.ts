import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "three/webgpu";
import type { Object3D } from "three/webgpu";
import { ParticleSystem } from "../effects/particles";
import { ContactWorld } from "./physics";

const HIT = 1.35;
const UP = new Vector3(0, 1, 0);

interface Craft {
  kind: "satellite" | "spacecraft";
  mesh: Group;
  handle: number;
  radius: number;
  angle: number;
  speed: number;
  tilt: number;
  node: number;
  pos: Vector3;
  steer: number;
  heading: Vector3;
}

export class CraftField {
  private readonly items: Craft[] = [];

  constructor(
    private readonly parent: Object3D,
    private readonly particles: ParticleSystem,
    private readonly world: ContactWorld,
    private readonly onBurst: (at: Vector3, linvel: Vector3, angvel: Vector3) => void,
  ) {}

  get satellites(): number {
    return this.items.filter((item) => item.kind === "satellite").length;
  }

  get spacecraft(): number {
    return this.items.filter((item) => item.kind === "spacecraft").length;
  }

  spawnSatellite(): number {
    const radius = 22 + Math.random() * 58;
    const craft: Craft = {
      kind: "satellite",
      mesh: satelliteMesh(),
      radius,
      angle: Math.random() * Math.PI * 2,
      speed: 0.18 + Math.random() * 0.35,
      tilt: (Math.random() - 0.5) * 0.55,
      node: Math.random() * Math.PI * 2,
      pos: new Vector3(),
      steer: 0,
      heading: new Vector3(),
      handle: 0,
    };
    this.placeOrbit(craft, 0);
    craft.handle = this.world.spawnKinematicBall(craft.pos, HIT, "satellite");
    this.parent.add(craft.mesh);
    this.items.push(craft);
    return this.satellites;
  }

  spawnSpacecraft(): number {
    const pos = randomPoint(28 + Math.random() * 40);
    const heading = new Vector3(Math.random() - 0.5, (Math.random() - 0.5) * 0.35, Math.random() - 0.5);
    if (heading.lengthSq() < 1e-6) heading.set(1, 0, 0);
    heading.normalize();
    const craft: Craft = {
      kind: "spacecraft",
      mesh: shipMesh(),
      radius: 0,
      angle: 0,
      speed: 8 + Math.random() * 10,
      tilt: 0,
      node: 0,
      pos,
      steer: 1.2 + Math.random() * 2.4,
      heading,
      handle: 0,
    };
    const lin = heading.clone().multiplyScalar(craft.speed);
    craft.handle = this.world.spawnDynamic({
      kind: "craft",
      tag: "spacecraft",
      pos,
      linvel: lin,
      angvel: new Vector3(),
      radius: HIT,
      half: new Vector3(),
      restitution: 0.3,
      friction: 0.45,
      ccd: true,
    });
    craft.mesh.position.copy(pos);
    aim(craft.mesh, lin);
    this.parent.add(craft.mesh);
    this.items.push(craft);
    return this.spacecraft;
  }

  clear(): void {
    for (const craft of this.items) this.dispose(craft);
    this.items.length = 0;
  }

  preStep(dt: number, paused: boolean): void {
    for (const craft of this.items) {
      if (craft.kind === "satellite") {
        if (paused) this.world.hold(craft.handle, craft.pos);
        else {
          this.placeOrbit(craft, dt);
          this.world.kinematicTo(craft.handle, craft.pos);
        }
        continue;
      }
      this.steerShip(craft, dt, paused);
    }
  }

  postStep(): void {
    const dead = new Set<Craft>();
    for (const craft of this.items) {
      const pose = this.world.read(craft.handle);
      if (!pose) continue;
      craft.pos.copy(pose.pos);
      craft.mesh.position.copy(pose.pos);
      if (craft.kind === "satellite") craft.mesh.lookAt(0, craft.pos.y, 0);
      else if (pose.angvel.lengthSq() > 0.2) craft.mesh.quaternion.copy(pose.rot);
      else if (pose.linvel.lengthSq() > 1e-6) aim(craft.mesh, pose.linvel);
      const hit = this.world.partners(craft.handle).some((partner) => partner.kind === "planet" || partner.kind === "craft" || partner.kind === "meteor");
      if (!hit) continue;
      dead.add(craft);
      this.particles.spawnExplosion(pose.pos.clone(), 0xfbbf24, 70);
      this.onBurst(pose.pos.clone(), pose.linvel.clone(), pose.angvel.clone());
    }
    if (dead.size === 0) return;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (!dead.has(this.items[i])) continue;
      this.dispose(this.items[i]);
      this.items.splice(i, 1);
    }
  }

  private placeOrbit(craft: Craft, dt: number): void {
    craft.angle += craft.speed * dt;
    const cosN = Math.cos(craft.node);
    const sinN = Math.sin(craft.node);
    const x = Math.cos(craft.angle) * craft.radius;
    const z = Math.sin(craft.angle) * craft.radius;
    const y = Math.sin(craft.angle) * Math.sin(craft.tilt) * craft.radius;
    craft.pos.set(cosN * x - sinN * z, y, sinN * x + cosN * z);
  }

  private steerShip(craft: Craft, dt: number, paused: boolean): void {
    if (paused) {
      this.world.hold(craft.handle, craft.pos);
      return;
    }
    craft.steer -= dt;
    const pose = this.world.read(craft.handle);
    if (pose) craft.pos.copy(pose.pos);
    if (craft.steer <= 0 || craft.pos.length() > 96) {
      const home = craft.pos.length() > 96;
      craft.heading.set(
        home ? -craft.pos.x : Math.random() - 0.5,
        (Math.random() - 0.5) * 0.4,
        home ? -craft.pos.z : Math.random() - 0.5,
      );
      if (craft.heading.lengthSq() < 1e-6) craft.heading.set(1, 0, 0);
      craft.heading.normalize();
      craft.steer = 1.4 + Math.random() * 2.8;
    }
    this.world.steer(craft.handle, craft.heading.clone().multiplyScalar(craft.speed), dt);
  }

  private dispose(craft: Craft): void {
    this.world.remove(craft.handle);
    const seen = new Set<Material>();
    craft.mesh.traverse((child) => {
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
    this.parent.remove(craft.mesh);
  }
}

function satelliteMesh(): Group {
  const group = new Group();
  const body = new Mesh(
    new SphereGeometry(0.55, 12, 10),
    new MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.45, metalness: 0.55 }),
  );
  const panelMat = new MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.35, metalness: 0.2 });
  const left = new Mesh(new BoxGeometry(1.5, 0.06, 0.55), panelMat);
  const right = new Mesh(new BoxGeometry(1.5, 0.06, 0.55), panelMat.clone());
  left.position.x = -1.15;
  right.position.x = 1.15;
  group.add(body, left, right);
  return group;
}

function shipMesh(): Group {
  const group = new Group();
  const hull = new Mesh(
    new ConeGeometry(0.38, 1.7, 8),
    new MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4, metalness: 0.35 }),
  );
  hull.rotation.x = Math.PI / 2;
  const fin = new Mesh(
    new BoxGeometry(1.1, 0.08, 0.35),
    new MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.5, metalness: 0.2 }),
  );
  fin.position.z = -0.45;
  group.add(hull, fin);
  return group;
}

function aim(mesh: Group, vel: Vector3): void {
  const dir = vel.clone().normalize();
  mesh.quaternion.setFromUnitVectors(UP, dir);
}

function randomPoint(radius: number): Vector3 {
  const theta = Math.random() * Math.PI * 2;
  const y = (Math.random() - 0.5) * radius * 0.25;
  return new Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius);
}
