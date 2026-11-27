import RAPIER from "@dimforge/rapier3d-compat";
import type { Collider, RigidBody } from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three/webgpu";

export type BodyKind = "planet" | "craft" | "meteor" | "debris";

export interface ContactPartner {
  handle: number;
  kind: BodyKind;
  tag: string;
}

interface Actor {
  body: RigidBody;
  collider: Collider;
  kind: BodyKind;
  tag: string;
  radius: number;
}

const posePos = new Vector3();
const poseRot = new Quaternion();
const poseLin = new Vector3();
const poseAng = new Vector3();

let boot: Promise<void> | null = null;

/** Loads the Rapier WASM module. Call once before `ContactWorld`. */
export function initPhysics(): Promise<void> {
  boot ??= RAPIER.init();
  return boot;
}

/**
 * One rigid-body world for craft, meteors, debris, and impact contact.
 * Planet orbits are not integrated here. Kinematic planet colliders are
 * teleported to the Kepler pose each frame.
 */
export class ContactWorld {
  private readonly world: RAPIER.World;
  private readonly queue: RAPIER.EventQueue;
  private readonly actors = new Map<number, Actor>();
  private readonly byCollider = new Map<number, number>();

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.queue = new RAPIER.EventQueue(true);
  }

  /** Pose a planet collider. Rapier does not integrate this body. */
  syncPlanet(id: string, pos: Vector3, radius: number, alive: boolean): void {
    const limit = Math.max(radius, 0.2);
    let actor = this.findTag("planet", id);
    if (!actor) {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setCanSleep(false),
      );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.ball(limit).setRestitution(0.25).setFriction(0.65),
        body,
      );
      actor = this.track(body, collider, "planet", id, limit);
    }
    actor.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    actor.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (Math.abs(actor.radius - limit) > 0.08) {
      actor.collider.setRadius(limit);
      actor.radius = limit;
    }
    actor.collider.setEnabled(alive);
  }

  spawnKinematicBall(pos: Vector3, radius: number, tag: string): number {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(pos.x, pos.y, pos.z)
        .setCanSleep(false),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius).setRestitution(0.2).setFriction(0.5),
      body,
    );
    return this.track(body, collider, "craft", tag, radius).body.handle;
  }

  spawnDynamic(opts: {
    kind: "craft" | "meteor" | "debris";
    tag: string;
    pos: Vector3;
    linvel: Vector3;
    angvel: Vector3;
    radius?: number;
    half: Vector3;
    restitution: number;
    friction: number;
    ccd: boolean;
  }): number {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(opts.pos.x, opts.pos.y, opts.pos.z)
        .setLinvel(opts.linvel.x, opts.linvel.y, opts.linvel.z)
        .setAngvel({ x: opts.angvel.x, y: opts.angvel.y, z: opts.angvel.z })
        .setLinearDamping(0.02)
        .setAngularDamping(0.04)
        .setCcdEnabled(opts.ccd)
        .setCanSleep(false),
    );
    const desc = (
      opts.radius !== undefined
        ? RAPIER.ColliderDesc.ball(opts.radius)
        : RAPIER.ColliderDesc.cuboid(opts.half.x, opts.half.y, opts.half.z)
    )
      .setDensity(1.2)
      .setRestitution(opts.restitution)
      .setFriction(opts.friction);
    const collider = this.world.createCollider(desc, body);
    const radius = opts.radius ?? Math.max(opts.half.x, opts.half.y, opts.half.z);
    return this.track(body, collider, opts.kind, opts.tag, radius).body.handle;
  }

  kinematicTo(handle: number, pos: Vector3): void {
    const actor = this.actors.get(handle);
    if (!actor) return;
    actor.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
  }

  hold(handle: number, pos: Vector3): void {
    const actor = this.actors.get(handle);
    if (!actor) return;
    actor.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    actor.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  steer(handle: number, desired: Vector3, dt: number): void {
    const actor = this.actors.get(handle);
    if (!actor) return;
    const lin = actor.body.linvel();
    const mass = Math.max(actor.body.mass(), 0.001);
    const gain = Math.min(1, dt * 1.6);
    actor.body.applyImpulse(
      {
        x: (desired.x - lin.x) * mass * gain,
        y: (desired.y - lin.y) * mass * gain,
        z: (desired.z - lin.z) * mass * gain,
      },
      true,
    );
  }

  applyAccel(handle: number, acc: Vector3, dt: number): void {
    const actor = this.actors.get(handle);
    if (!actor) return;
    const mass = Math.max(actor.body.mass(), 0.001);
    actor.body.applyImpulse({ x: acc.x * mass * dt, y: acc.y * mass * dt, z: acc.z * mass * dt }, true);
  }

  reverseVelocity(handle: number): void {
    const actor = this.actors.get(handle);
    if (!actor) return;
    const lin = actor.body.linvel();
    const ang = actor.body.angvel();
    actor.body.setLinvel({ x: -lin.x, y: -lin.y, z: -lin.z }, true);
    actor.body.setAngvel({ x: -ang.x, y: -ang.y, z: -ang.z }, true);
  }

  read(handle: number): { pos: Vector3; rot: Quaternion; linvel: Vector3; angvel: Vector3 } | null {
    const actor = this.actors.get(handle);
    if (!actor) return null;
    const t = actor.body.translation();
    const r = actor.body.rotation();
    const lin = actor.body.linvel();
    const ang = actor.body.angvel();
    posePos.set(t.x, t.y, t.z);
    poseRot.set(r.x, r.y, r.z, r.w);
    poseLin.set(lin.x, lin.y, lin.z);
    poseAng.set(ang.x, ang.y, ang.z);
    return { pos: posePos, rot: poseRot, linvel: poseLin, angvel: poseAng };
  }

  partners(handle: number): ContactPartner[] {
    const actor = this.actors.get(handle);
    if (!actor) return [];
    const found: ContactPartner[] = [];
    this.world.contactPairsWith(actor.collider, (other) => {
      const owner = this.byCollider.get(other.handle);
      if (owner === undefined || owner === handle) return;
      const partner = this.actors.get(owner);
      if (!partner || !partner.collider.isEnabled()) return;
      found.push({ handle: owner, kind: partner.kind, tag: partner.tag });
    });
    return found;
  }

  remove(handle: number): void {
    const actor = this.actors.get(handle);
    if (!actor) return;
    this.byCollider.delete(actor.collider.handle);
    this.actors.delete(handle);
    this.world.removeRigidBody(actor.body);
  }

  step(dt: number): void {
    if (dt <= 0) return;
    this.world.timestep = Math.min(dt, 0.05);
    this.world.step(this.queue);
  }

  private findTag(kind: BodyKind, tag: string): Actor | undefined {
    for (const actor of this.actors.values()) {
      if (actor.kind === kind && actor.tag === tag) return actor;
    }
    return undefined;
  }

  private track(body: RigidBody, collider: Collider, kind: BodyKind, tag: string, radius: number): Actor {
    const actor: Actor = { body, collider, kind, tag, radius };
    this.actors.set(body.handle, actor);
    this.byCollider.set(collider.handle, body.handle);
    return actor;
  }
}
