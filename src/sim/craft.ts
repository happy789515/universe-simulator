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
import { Dyn, integrate, resolveContact } from "./physics";

const HIT = 1.35;
const UP = new Vector3(0, 1, 0);

export interface CraftTarget {
  position: Vector3;
  radius: number;
  alive: boolean;
}

interface Craft {
  kind: "satellite" | "spacecraft";
  mesh: Group;
  radius: number;
  angle: number;
  speed: number;
  tilt: number;
  node: number;
  pos: Vector3;
  vel: Vector3;
  steer: number;
  heading: Vector3;
}

export class CraftField {
  private readonly items: Craft[] = [];

  constructor(
    private readonly parent: Object3D,
    private readonly particles: ParticleSystem,
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
      vel: new Vector3(),
      steer: 0,
      heading: new Vector3(),
    };
    this.placeSatellite(craft, 0);
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
      vel: heading.clone().multiplyScalar(8 + Math.random() * 10),
      steer: 1.2 + Math.random() * 2.4,
      heading,
    };
    craft.mesh.position.copy(pos);
    aim(craft.mesh, craft.vel);
    this.parent.add(craft.mesh);
    this.items.push(craft);
    return this.spacecraft;
  }

  clear(): void {
    for (const craft of this.items) this.dispose(craft);
    this.items.length = 0;
  }

  update(dt: number, targets: readonly CraftTarget[]): void {
    if (dt <= 0 || this.items.length === 0) return;
    const steps = Math.max(1, Math.ceil(dt / 0.02));
    const h = dt / steps;
    for (let step = 0; step < steps; step++) {
      for (const craft of this.items) {
        if (craft.kind === "satellite") this.placeSatellite(craft, h);
        else this.flyShip(craft, h);
      }
      if (this.collide(targets)) break;
    }
  }

  private placeSatellite(craft: Craft, dt: number): void {
    const before = craft.pos.clone();
    craft.angle += craft.speed * dt;
    const cosN = Math.cos(craft.node);
    const sinN = Math.sin(craft.node);
    const x = Math.cos(craft.angle) * craft.radius;
    const z = Math.sin(craft.angle) * craft.radius;
    const y = Math.sin(craft.angle) * Math.sin(craft.tilt) * craft.radius;
    craft.pos.set(cosN * x - sinN * z, y, sinN * x + cosN * z);
    if (dt > 1e-6) craft.vel.copy(craft.pos).sub(before).multiplyScalar(1 / dt);
    craft.mesh.position.copy(craft.pos);
    craft.mesh.lookAt(0, craft.pos.y, 0);
  }

  private flyShip(craft: Craft, dt: number): void {
    craft.steer -= dt;
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
    const acc = craft.heading.clone().multiplyScalar(craft.speed).sub(craft.vel).multiplyScalar(1.6);
    const body: Dyn = { pos: craft.pos, vel: craft.vel, radius: HIT, invMass: 1 };
    integrate(body, acc, dt);
    craft.mesh.position.copy(craft.pos);
    if (craft.vel.lengthSq() > 1e-6) aim(craft.mesh, craft.vel);
  }

  private collide(targets: readonly CraftTarget[]): boolean {
    const dead = new Set<Craft>();
    const bursts: { at: Vector3; vel: Vector3 }[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const a = this.items[i];
      const bodyA: Dyn = { pos: a.pos, vel: a.vel, radius: HIT, invMass: 1 };
      for (let j = i + 1; j < this.items.length; j++) {
        const b = this.items[j];
        const bodyB: Dyn = { pos: b.pos, vel: b.vel, radius: HIT, invMass: 1 };
        if (!resolveContact(bodyA, bodyB, 0.2)) continue;
        dead.add(a);
        dead.add(b);
        bursts.push({
          at: a.pos.clone().add(b.pos).multiplyScalar(0.5),
          vel: a.vel.clone().add(b.vel).multiplyScalar(0.5),
        });
      }
      if (dead.has(a)) continue;
      for (const target of targets) {
        if (!target.alive) continue;
        const planet: Dyn = {
          pos: target.position.clone(),
          vel: new Vector3(),
          radius: target.radius,
          invMass: 0,
        };
        if (!resolveContact(bodyA, planet, 0.35)) continue;
        dead.add(a);
        bursts.push({ at: a.pos.clone(), vel: a.vel.clone() });
        break;
      }
    }
    if (dead.size === 0) return false;
    for (const burst of bursts) {
      this.particles.spawnExplosion(burst.at, 0xfbbf24, 70);
      this.particles.spawnExplosion(burst.at.clone().addScaledVector(burst.vel, 0.04), 0xfde68a, 24);
    }
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (!dead.has(this.items[i])) continue;
      this.dispose(this.items[i]);
      this.items.splice(i, 1);
    }
    return true;
  }

  private dispose(craft: Craft): void {
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
