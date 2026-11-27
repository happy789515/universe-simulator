import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  FrontSide,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from "three/webgpu";
import {
  abs,
  add,
  cameraPosition,
  color,
  dot,
  float,
  max,
  mul,
  negate,
  normalWorld,
  normalize,
  oneMinus,
  positionWorld,
  pow,
  sub,
  uniform,
} from "three/tsl";
import { PlanetDefinition, bodyRadiusSceneUnits } from "../data/planets";

const TEX_W = 512;
const TEX_H = 256;

const PERM = new Uint8Array(512);
{
  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i++) source[i] = i;
  let seed = 2166136261;
  for (let i = 255; i > 0; i--) {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822519);
    const j = (seed >>> 0) % (i + 1);
    const swap = source[i];
    source[i] = source[j];
    source[j] = swap;
  }
  for (let i = 0; i < 512; i++) PERM[i] = source[i & 255];
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const zi = Math.floor(z) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const zf = z - Math.floor(z);
  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);
  const a = PERM[xi] + yi;
  const aa = PERM[a] + zi;
  const ab = PERM[a + 1] + zi;
  const b = PERM[xi + 1] + yi;
  const ba = PERM[b] + zi;
  const bb = PERM[b + 1] + zi;
  const x1 = grad(PERM[aa], xf, yf, zf) + (grad(PERM[ba], xf - 1, yf, zf) - grad(PERM[aa], xf, yf, zf)) * u;
  const x2 = grad(PERM[ab], xf, yf - 1, zf) + (grad(PERM[bb], xf - 1, yf - 1, zf) - grad(PERM[ab], xf, yf - 1, zf)) * u;
  const y1 = x1 + (x2 - x1) * v;
  const x3 = grad(PERM[aa + 1], xf, yf, zf - 1) + (grad(PERM[ba + 1], xf - 1, yf, zf - 1) - grad(PERM[aa + 1], xf, yf, zf - 1)) * u;
  const x4 = grad(PERM[ab + 1], xf, yf - 1, zf - 1) + (grad(PERM[bb + 1], xf - 1, yf - 1, zf - 1) - grad(PERM[ab + 1], xf, yf - 1, zf - 1)) * u;
  const y2 = x3 + (x4 - x3) * v;
  return y1 + (y2 - y1) * w;
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

interface Sample {
  height: number;
  r: number;
  g: number;
  b: number;
  rough: number;
}

function craters(x: number, y: number, z: number, seed: number): number {
  let h = 0.46 + fbm(x * 2 + seed, y * 2, z * 2, 4) * 0.1;
  const n = fbm(x * 6.5 + seed, y * 6.5, z * 6.5, 3);
  const ridge = 1 - Math.abs(n);
  h += smooth(0.62, 0.86, ridge) * 0.14;
  h -= smooth(0.78, 0.98, ridge) * 0.26;
  const n2 = fbm(x * 14 + 2, y * 14, z * 14 + seed, 2);
  const ridge2 = 1 - Math.abs(n2);
  h += smooth(0.7, 0.9, ridge2) * 0.05;
  h -= smooth(0.84, 0.98, ridge2) * 0.09;
  return clamp01(h);
}

function sampleSurface(def: PlanetDefinition, x: number, y: number, z: number): Sample {
  const seed = def.semiMajorAxisAu * 3.1;
  if (def.surface === "cratered") {
    const h = craters(x, y, z, seed);
    const shade = 0.45 + h * 0.5;
    return { height: h, r: 150 * shade, g: 142 * shade, b: 132 * shade, rough: 210 + h * 40 };
  }
  if (def.surface === "cloudy") {
    const n = fbm(x * 2.4 + seed, y * 3.2, z * 2.4, 5);
    const h = clamp01(0.5 + n * 0.08);
    const t = n * 0.5 + 0.5;
    return {
      height: h,
      r: mix(210, 245, t),
      g: mix(170, 214, t),
      b: mix(90, 140, t),
      rough: 170 + t * 40,
    };
  }
  if (def.surface === "terra") {
    const n = fbm(x * 1.7 + seed, y * 1.7, z * 1.7, 5);
    const land = n > 0.02;
    const ice = Math.abs(y) > 0.86;
    const h = ice ? 0.66 : land ? clamp01(0.5 + (n - 0.02) * 0.85) : 0.32;
    if (ice) return { height: h, r: 236, g: 242, b: 246, rough: 55 };
    if (!land) {
      const depth = clamp01(0.5 + n);
      return { height: h, r: mix(12, 28, depth), g: mix(70, 110, depth), b: mix(140, 180, depth), rough: 28 };
    }
    const dry = fbm(x * 4 + 9, y * 4, z * 4, 3);
    const mount = h > 0.72;
    if (mount) return { height: h, r: 214, g: 210, b: 200, rough: 150 };
    if (dry > 0.25) return { height: h, r: 186, g: 154, b: 96, rough: 200 };
    return { height: h, r: 46, g: 110, b: 58, rough: 185 };
  }
  if (def.surface === "desert") {
    const h = craters(x, y, z, seed + 4);
    const region = fbm(x * 1.4, y * 1.4, z * 1.4, 3);
    const ice = Math.abs(y) > 0.9;
    if (ice) return { height: 0.7, r: 240, g: 236, b: 230, rough: 70 };
    const shade = 0.55 + region * 0.35;
    return {
      height: h,
      r: (region > 0 ? 196 : 120) * shade,
      g: (region > 0 ? 92 : 48) * shade,
      b: (region > 0 ? 58 : 36) * shade,
      rough: 200,
    };
  }
  const warp = fbm(x * 3 + seed, y * 2, z * 3, 4) * 0.08;
  const band = Math.sin((y + warp) * Math.PI * (def.id === "saturn" ? 10 : 14));
  const h = clamp01(0.5 + band * 0.08 + fbm(x * 2, y * 2, z * 2, 3) * 0.04);
  const t = band * 0.5 + 0.5;
  let r: number;
  let g: number;
  let b: number;
  if (def.surface === "ice") {
    r = mix(def.id === "neptune" ? 18 : 150, def.id === "neptune" ? 70 : 230, t);
    g = mix(def.id === "neptune" ? 60 : 210, def.id === "neptune" ? 130 : 246, t);
    b = mix(def.id === "neptune" ? 150 : 210, def.id === "neptune" ? 230 : 246, t);
  } else if (def.id === "saturn") {
    r = mix(214, 246, t);
    g = mix(186, 226, t);
    b = mix(140, 186, t);
  } else {
    r = mix(150, 244, t);
    g = mix(78, 214, t);
    b = mix(36, 160, t);
  }
  if (def.spot) {
    const sx = def.id === "jupiter" ? 0.82 : -0.2;
    const sy = def.id === "jupiter" ? -0.22 : 0.15;
    const sz = def.id === "jupiter" ? 0.35 : 0.9;
    const len = Math.hypot(sx, sy, sz);
    const align = (x * sx + y * sy + z * sz) / len;
    if (align > 0.94) {
      r = def.id === "jupiter" ? 176 : 16;
      g = def.id === "jupiter" ? 64 : 36;
      b = def.id === "jupiter" ? 42 : 90;
    }
  }
  return { height: h, r, g, b, rough: def.surface === "ice" ? 90 : 150 };
}

function canvasFrom(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return canvas;
}

function dirFromUv(u: number, v: number): { x: number; y: number; z: number } {
  const theta = v * Math.PI;
  const phi = u * Math.PI * 2;
  const st = Math.sin(theta);
  return { x: st * Math.cos(phi), y: Math.cos(theta), z: st * Math.sin(phi) };
}

export interface AtmoFade {
  value: number;
}

export interface PlanetLook {
  mesh: Mesh;
  material: MeshStandardMaterial;
  clouds: Mesh | null;
  atmosphere: Mesh | null;
  atmoFade: AtmoFade | null;
  rings: Mesh | null;
  nightEmissive: number;
  nightLevel: number;
  radius: number;
}

export function createPlanetLook(def: PlanetDefinition): PlanetLook {
  const radius = bodyRadiusSceneUnits(def.radiusEarth);
  const heights = new Float32Array(TEX_W * TEX_H);
  const colorBytes = new Uint8ClampedArray(TEX_W * TEX_H * 4);
  const roughBytes = new Uint8ClampedArray(TEX_W * TEX_H * 4);
  const normalBytes = new Uint8ClampedArray(TEX_W * TEX_H * 4);

  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const dir = dirFromUv((x + 0.5) / TEX_W, (y + 0.5) / TEX_H);
      const sample = sampleSurface(def, dir.x, dir.y, dir.z);
      const i = x + y * TEX_W;
      heights[i] = sample.height;
      const p = i * 4;
      colorBytes[p] = sample.r;
      colorBytes[p + 1] = sample.g;
      colorBytes[p + 2] = sample.b;
      colorBytes[p + 3] = 255;
      roughBytes[p] = sample.rough;
      roughBytes[p + 1] = sample.rough;
      roughBytes[p + 2] = sample.rough;
      roughBytes[p + 3] = 255;
    }
  }

  const strength = 2.4;
  for (let y = 0; y < TEX_H; y++) {
    for (let x = 0; x < TEX_W; x++) {
      const hL = heights[((x - 1 + TEX_W) % TEX_W) + y * TEX_W];
      const hR = heights[((x + 1) % TEX_W) + y * TEX_W];
      const yD = Math.max(0, y - 1);
      const yU = Math.min(TEX_H - 1, y + 1);
      const hD = heights[x + yD * TEX_W];
      const hU = heights[x + yU * TEX_W];
      const theta = ((y + 0.5) / TEX_H) * Math.PI;
      const sinT = Math.max(Math.sin(theta), 0.25);
      const dhdx = ((hR - hL) / sinT) * strength;
      const dhdy = (hU - hD) * strength;
      let nx = -dhdx;
      let ny = -dhdy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const p = (x + y * TEX_W) * 4;
      normalBytes[p] = (nx * 0.5 + 0.5) * 255;
      normalBytes[p + 1] = (ny * 0.5 + 0.5) * 255;
      normalBytes[p + 2] = (nz * 0.5 + 0.5) * 255;
      normalBytes[p + 3] = 255;
    }
  }

  const map = new CanvasTexture(canvasFrom(colorBytes, TEX_W, TEX_H));
  map.colorSpace = SRGBColorSpace;
  map.wrapS = RepeatWrapping;
  map.anisotropy = 8;
  const roughMap = new CanvasTexture(canvasFrom(roughBytes, TEX_W, TEX_H));
  roughMap.colorSpace = NoColorSpace;
  roughMap.wrapS = RepeatWrapping;
  const normalMap = new CanvasTexture(canvasFrom(normalBytes, TEX_W, TEX_H));
  normalMap.colorSpace = NoColorSpace;
  normalMap.wrapS = RepeatWrapping;

  const geo = new SphereGeometry(radius, 80, 48);
  const pos = geo.attributes.position;
  const vertex = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < pos.count; i++) {
    vertex.x = pos.getX(i);
    vertex.y = pos.getY(i);
    vertex.z = pos.getZ(i);
    const len = Math.hypot(vertex.x, vertex.y, vertex.z) || 1;
    const dx = vertex.x / len;
    const dy = vertex.y / len;
    const dz = vertex.z / len;
    const h = sampleSurface(def, dx, dy, dz).height;
    const r = radius * (1 + (h - 0.5) * 2 * def.displace);
    pos.setXYZ(i, dx * r, dy * r * (1 - def.oblateness), dz * r);
  }
  geo.computeVertexNormals();

  const nightEmissive = def.surface === "terra" ? 0x2a2418 : 0x142033;
  const nightLevel = def.surface === "terra" ? 0.22 : 0.12;
  const material = new MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new Vector2(1.15, 1.15),
    roughnessMap: roughMap,
    roughness: 1,
    metalness: 0,
    emissive: nightEmissive,
    emissiveIntensity: nightLevel,
  });
  const mesh = new Mesh(geo, material);
  mesh.name = def.id;

  let clouds: Mesh | null = null;
  if (def.hasClouds) {
    clouds = new Mesh(new SphereGeometry(radius * 1.025, 48, 32), cloudMaterial(def));
    clouds.castShadow = false;
    clouds.receiveShadow = false;
    mesh.add(clouds);
  }

  let atmosphere: Mesh | null = null;
  let atmoFade: AtmoFade | null = null;
  if (def.atmosphere !== 0 && def.atmoStrength > 0) {
    const shell = limbShell(radius * 1.08, def.atmosphere, def.atmoStrength);
    atmosphere = shell.mesh;
    atmoFade = shell.fade;
    mesh.add(atmosphere);
  }

  let rings: Mesh | null = null;
  if (def.hasRings) {
    rings = new Mesh(new RingGeometry(radius * 1.45, radius * 2.25, 96), ringMaterial());
    rings.rotation.x = Math.PI / 2;
    rings.castShadow = false;
    rings.receiveShadow = false;
    mesh.add(rings);
    const shadow = new Mesh(
      new TorusGeometry(radius * 1.01, radius * 0.05, 8, 72),
      new MeshStandardMaterial({
        color: 0x07060a,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = Math.PI / 2;
    shadow.castShadow = false;
    shadow.receiveShadow = false;
    mesh.add(shadow);
  }

  return { mesh, material, clouds, atmosphere, atmoFade, rings, nightEmissive, nightLevel, radius };
}

function cloudMaterial(def: PlanetDefinition): MeshStandardMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const image = ctx.createImageData(512, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 512; x++) {
      const dir = dirFromUv((x + 0.5) / 512, (y + 0.5) / 256);
      const n = fbm(dir.x * 3.2 + 4, dir.y * 2.4, dir.z * 3.2, 5);
      const puff = smooth(0.05, 0.45, n);
      const p = (x + y * 512) * 4;
      const white = def.surface === "cloudy" ? 230 : 255;
      image.data[p] = white;
      image.data[p + 1] = white;
      image.data[p + 2] = def.surface === "cloudy" ? 210 : 255;
      image.data[p + 3] = puff * (def.surface === "cloudy" ? 90 : 170);
    }
  }
  ctx.putImageData(image, 0, 0);
  const map = new CanvasTexture(canvas);
  map.colorSpace = SRGBColorSpace;
  map.wrapS = RepeatWrapping;
  return new MeshStandardMaterial({
    map,
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
  });
}

let sharedRing: CanvasTexture | null = null;

function ringMaterial(): MeshStandardMaterial {
  if (!sharedRing) {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    const image = ctx.createImageData(size, size);
    const cx = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x - cx, y - cx) / cx;
        const p = (x + y * size) * 4;
        const inner = 1.45 / 2.25;
        if (r < inner || r > 0.995) continue;
        const t = (r - inner) / (1 - inner);
        const gap = t > 0.42 && t < 0.5;
        const band = 0.55 + 0.45 * Math.sin(t * 36);
        image.data[p] = 40 + 190 * band;
        image.data[p + 1] = 32 + 170 * band;
        image.data[p + 2] = 24 + 130 * band;
        image.data[p + 3] = gap ? 0 : 150 + band * 80;
      }
    }
    ctx.putImageData(image, 0, 0);
    sharedRing = new CanvasTexture(canvas);
    sharedRing.colorSpace = SRGBColorSpace;
    sharedRing.anisotropy = 8;
  }
  return new MeshStandardMaterial({
    map: sharedRing,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    roughness: 0.72,
    metalness: 0,
  });
}

function limbShell(radius: number, tint: number, strength: number): { mesh: Mesh; fade: AtmoFade } {
  const fade = uniform(1);
  const mat = new MeshBasicNodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = AdditiveBlending;
  mat.side = FrontSide;
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const nrm = normalize(normalWorld);
  const fres = pow(oneMinus(abs(dot(nrm, viewDir))), float(2.8));
  const sunDir = normalize(negate(positionWorld));
  const day = max(dot(nrm, sunDir), float(0));
  const glow = mul(fres, add(mul(day, float(0.8)), float(0.16)));
  mat.colorNode = color(tint);
  mat.opacityNode = mul(mul(glow, float(strength)), fade);
  const mesh = new Mesh(new SphereGeometry(radius, 40, 24), mat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, fade };
}

export function createSunMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  mat.colorNode = mul(color(0xfff1c2), float(3.2));
  return mat;
}

export function createSunCorona(radius: number): Mesh {
  return limbShell(radius * 1.7, 0xffd27a, 0.28).mesh;
}
