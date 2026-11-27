import { Vector3 } from "three/webgpu";

export interface Dyn {
  pos: Vector3;
  vel: Vector3;
  radius: number;
  /** 0 keeps the body fixed. Planets use 0. */
  invMass: number;
}

/** Semi-implicit Euler. */
export function integrate(body: Dyn, acc: Vector3, dt: number): void {
  body.vel.addScaledVector(acc, dt);
  body.pos.addScaledVector(body.vel, dt);
}

/**
 * Separates overlapping bodies and applies a normal impulse.
 * A fixed body (invMass 0) does not move. Returns true on contact.
 */
export function resolveContact(a: Dyn, b: Dyn, restitution: number): boolean {
  const nx = b.pos.x - a.pos.x;
  const ny = b.pos.y - a.pos.y;
  const nz = b.pos.z - a.pos.z;
  const distSq = nx * nx + ny * ny + nz * nz;
  const limit = a.radius + b.radius;
  if (distSq > limit * limit) return false;
  const dist = Math.sqrt(Math.max(distSq, 1e-12));
  const ix = nx / dist;
  const iy = ny / dist;
  const iz = nz / dist;
  const rel =
    (b.vel.x - a.vel.x) * ix + (b.vel.y - a.vel.y) * iy + (b.vel.z - a.vel.z) * iz;
  const inv = a.invMass + b.invMass;
  const pen = limit - dist;
  if (inv > 0 && pen > 0) {
    const corr = pen / inv;
    a.pos.x -= ix * corr * a.invMass;
    a.pos.y -= iy * corr * a.invMass;
    a.pos.z -= iz * corr * a.invMass;
    b.pos.x += ix * corr * b.invMass;
    b.pos.y += iy * corr * b.invMass;
    b.pos.z += iz * corr * b.invMass;
  }
  if (inv > 0 && rel < 0) {
    const j = (-(1 + restitution) * rel) / inv;
    a.vel.x -= ix * j * a.invMass;
    a.vel.y -= iy * j * a.invMass;
    a.vel.z -= iz * j * a.invMass;
    b.vel.x += ix * j * b.invMass;
    b.vel.y += iy * j * b.invMass;
    b.vel.z += iz * j * b.invMass;
  }
  return true;
}
