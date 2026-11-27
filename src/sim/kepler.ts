import { Vector3 } from "three/webgpu";
import {
  KM_PER_AU,
  PlanetDefinition,
  SUN_RADIUS_AU,
  orbitRadiusSceneUnits,
  radiusAu,
} from "../data/planets";

export const MU_SUN = 2.959122082855911e-4;

const DEG = Math.PI / 180;

export function solveKepler(mean: number, ecc: number): number {
  const wrapped = Math.atan2(Math.sin(mean), Math.cos(mean));
  let eccentric = ecc < 0.8 ? wrapped : Math.PI;
  for (let i = 0; i < 12; i++) {
    const residual = eccentric - ecc * Math.sin(eccentric) - wrapped;
    const slope = 1 - ecc * Math.cos(eccentric);
    const delta = residual / slope;
    eccentric -= delta;
    if (Math.abs(delta) < 1e-8) break;
  }
  return eccentric;
}

export function meanAnomalyOf(
  def: PlanetDefinition,
  days: number,
  epoch: number,
  mOffset: number,
): number {
  const motion = (2 * Math.PI) / def.orbitalPeriodDays;
  return epoch + motion * days + mOffset;
}

export function writePlanetAu(
  def: PlanetDefinition,
  meanAnomaly: number,
  eOffset: number,
  target: Vector3,
): void {
  const ecc = Math.min(0.85, Math.max(0, def.eccentricity + eOffset));
  const semi = def.semiMajorAxisAu;
  const eccentric = solveKepler(meanAnomaly, ecc);
  const cosE = Math.cos(eccentric);
  const sinE = Math.sin(eccentric);
  const x = semi * (cosE - ecc);
  const y = semi * Math.sqrt(Math.max(0, 1 - ecc * ecc)) * sinE;

  const inc = def.inclinationDeg * DEG;
  const node = def.ascendingNodeDeg * DEG;
  const peri = def.argPeriapsisDeg * DEG;
  const cosW = Math.cos(peri);
  const sinW = Math.sin(peri);
  const cosI = Math.cos(inc);
  const sinI = Math.sin(inc);
  const cosN = Math.cos(node);
  const sinN = Math.sin(node);

  const x1 = cosW * x - sinW * y;
  const y1 = sinW * x + cosW * y;
  const y2 = cosI * y1;
  const z2 = sinI * y1;
  const ex = cosN * x1 - sinN * y2;
  const ey = sinN * x1 + cosN * y2;
  target.set(ex, z2, ey);
}

export function writePlanetScene(
  def: PlanetDefinition,
  days: number,
  epoch: number,
  eOffset: number,
  mOffset: number,
  target: Vector3,
): number {
  writePlanetAu(
    def,
    meanAnomalyOf(def, days, epoch, mOffset),
    eOffset,
    target,
  );
  return scaleAuToScene(target);
}

export function scaleAuToScene(auPosition: Vector3): number {
  const au = auPosition.length();
  if (au < 1e-8) {
    auPosition.set(0, 0, 0);
    return 0;
  }
  auPosition.multiplyScalar(orbitRadiusSceneUnits(au) / au);
  return au;
}

export function earthExposure(au: number): number {
  const relative = 1 / Math.max(au * au, 1e-4);
  const compressed = Math.pow(relative, 0.22);
  return Math.min(1.65, Math.max(0.42, compressed));
}

export function sphereOfInfluence(def: PlanetDefinition): number {
  return def.semiMajorAxisAu * Math.pow(Math.max(def.massSun, 1e-12), 0.4);
}

export interface Occulter {
  pos: Vector3;
  radiusAu: number;
  alive: boolean;
}

export function isEclipsed(self: Vector3, others: readonly Occulter[]): boolean {
  const dist = self.length();
  if (dist < 1e-6) return false;
  const sunAngle = SUN_RADIUS_AU / dist;
  for (const other of others) {
    if (!other.alive) continue;
    const otherDist = other.pos.length();
    if (otherDist >= dist - 1e-5) continue;
    const separation = angleBetween(self, other.pos);
    const blocker = other.radiusAu / Math.max(self.distanceTo(other.pos), 1e-6);
    if (separation < blocker + sunAngle) return true;
  }
  return false;
}

function angleBetween(a: Vector3, b: Vector3): number {
  const denom = a.length() * b.length();
  if (denom < 1e-12) return Math.PI;
  const cos = Math.min(1, Math.max(-1, a.dot(b) / denom));
  return Math.acos(cos);
}

export function writeOrbitTrail(
  def: PlanetDefinition,
  days: number,
  epoch: number,
  eOffset: number,
  mOffset: number,
  positions: Float32Array,
  colors: Float32Array,
  steps: number,
): void {
  const motion = (2 * Math.PI) / def.orbitalPeriodDays;
  const head = epoch + motion * days + mOffset;
  const scratch = trailScratch;
  const r = ((def.color >> 16) & 255) / 255;
  const g = ((def.color >> 8) & 255) / 255;
  const b = (def.color & 255) / 255;
  for (let i = 0; i < steps; i++) {
    const along = steps === 1 ? 0 : i / (steps - 1);
    const mean = head - along * Math.PI * 2;
    writePlanetAu(def, mean, eOffset, scratch);
    scaleAuToScene(scratch);
    const o = i * 3;
    positions[o] = scratch.x;
    positions[o + 1] = scratch.y;
    positions[o + 2] = scratch.z;
    const fade = Math.pow(1 - along, 1.35);
    colors[o] = r * fade;
    colors[o + 1] = g * fade;
    colors[o + 2] = b * fade;
  }
}

const trailScratch = new Vector3();

export function bodyRadiusAu(radiusKm: number): number {
  return radiusAu(radiusKm);
}

export { KM_PER_AU };
