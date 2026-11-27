export type SurfaceStyle =
  | "cratered"
  | "cloudy"
  | "terra"
  | "desert"
  | "banded"
  | "ice";

export interface PlanetDefinition {
  id: string;
  nameKo: string;
  nameEn: string;
  /** Mean distance from Sun in AU */
  semiMajorAxisAu: number;
  /** Earth radii */
  radiusEarth: number;
  /** Mean radius in km, for labels */
  radiusKm: number;
  /** Sidereal orbital period in Earth days */
  orbitalPeriodDays: number;
  /** Mass in kilograms (NASA planetary fact sheet) */
  massKg: number;
  eccentricity: number;
  inclinationDeg: number;
  ascendingNodeDeg: number;
  argPeriapsisDeg: number;
  meanAnomalyDeg: number;
  axialTiltDeg: number;
  /** Visual spin, radians per sim-day */
  spinRadPerDay: number;
  /** Solar masses, used for meteor sphere of influence */
  massSun: number;
  color: number;
  surface: SurfaceStyle;
  oblateness: number;
  displace: number;
  /** Limb tint. 0 skips the shell. */
  atmosphere: number;
  atmoStrength: number;
  hasClouds?: boolean;
  hasRings?: boolean;
  /** Great red / dark spot */
  spot?: boolean;
}

export const SUN_RADIUS_EARTH = 109;
export const SUN_RADIUS_AU = 0.00465047;
export const KM_PER_AU = 149_597_870.7;

export const PLANETS: PlanetDefinition[] = [
  {
    id: "mercury",
    nameKo: "수성",
    nameEn: "Mercury",
    semiMajorAxisAu: 0.387,
    radiusEarth: 0.383,
    radiusKm: 2439.7,
    orbitalPeriodDays: 88,
    massKg: 3.3011e23,
    eccentricity: 0.2056,
    inclinationDeg: 7.0,
    ascendingNodeDeg: 48.3,
    argPeriapsisDeg: 29.1,
    meanAnomalyDeg: 174,
    axialTiltDeg: 0.03,
    spinRadPerDay: 0.02,
    massSun: 1.651e-7,
    color: 0x9ca3af,
    surface: "cratered",
    oblateness: 0,
    displace: 0.085,
    atmosphere: 0,
    atmoStrength: 0,
  },
  {
    id: "venus",
    nameKo: "금성",
    nameEn: "Venus",
    semiMajorAxisAu: 0.723,
    radiusEarth: 0.949,
    radiusKm: 6051.8,
    orbitalPeriodDays: 224.7,
    massKg: 4.8675e24,
    eccentricity: 0.0068,
    inclinationDeg: 3.39,
    ascendingNodeDeg: 76.7,
    argPeriapsisDeg: 54.9,
    meanAnomalyDeg: 50,
    axialTiltDeg: 177,
    spinRadPerDay: -0.015,
    massSun: 2.447e-6,
    color: 0xeab676,
    surface: "cloudy",
    oblateness: 0,
    displace: 0.012,
    atmosphere: 0xf0c27a,
    atmoStrength: 1.15,
    hasClouds: true,
  },
  {
    id: "earth",
    nameKo: "지구",
    nameEn: "Earth",
    semiMajorAxisAu: 1,
    radiusEarth: 1,
    radiusKm: 6371,
    orbitalPeriodDays: 365.25,
    massKg: 5.9724e24,
    eccentricity: 0.0167,
    inclinationDeg: 0,
    ascendingNodeDeg: 0,
    argPeriapsisDeg: 102.9,
    meanAnomalyDeg: 20,
    axialTiltDeg: 23.4,
    spinRadPerDay: 0.12,
    massSun: 3.003e-6,
    color: 0x3b82f6,
    surface: "terra",
    oblateness: 0.003,
    displace: 0.05,
    atmosphere: 0x8ec5ff,
    atmoStrength: 1.05,
    hasClouds: true,
  },
  {
    id: "mars",
    nameKo: "화성",
    nameEn: "Mars",
    semiMajorAxisAu: 1.524,
    radiusEarth: 0.532,
    radiusKm: 3389.5,
    orbitalPeriodDays: 687,
    massKg: 6.4171e23,
    eccentricity: 0.0934,
    inclinationDeg: 1.85,
    ascendingNodeDeg: 49.6,
    argPeriapsisDeg: 286.5,
    meanAnomalyDeg: 19,
    axialTiltDeg: 25.2,
    spinRadPerDay: 0.11,
    massSun: 3.213e-7,
    color: 0xef4444,
    surface: "desert",
    oblateness: 0.006,
    displace: 0.065,
    atmosphere: 0xe08a62,
    atmoStrength: 0.42,
  },
  {
    id: "jupiter",
    nameKo: "목성",
    nameEn: "Jupiter",
    semiMajorAxisAu: 5.204,
    radiusEarth: 11.21,
    radiusKm: 69911,
    orbitalPeriodDays: 4333,
    massKg: 1.8982e27,
    eccentricity: 0.0489,
    inclinationDeg: 1.3,
    ascendingNodeDeg: 100.5,
    argPeriapsisDeg: 273.9,
    meanAnomalyDeg: 20,
    axialTiltDeg: 3.1,
    spinRadPerDay: 0.28,
    massSun: 9.545e-4,
    color: 0xd97706,
    surface: "banded",
    oblateness: 0.065,
    displace: 0.02,
    atmosphere: 0xf0d0a0,
    atmoStrength: 0.55,
    spot: true,
  },
  {
    id: "saturn",
    nameKo: "토성",
    nameEn: "Saturn",
    semiMajorAxisAu: 9.582,
    radiusEarth: 9.45,
    radiusKm: 58232,
    orbitalPeriodDays: 10759,
    massKg: 5.6834e26,
    eccentricity: 0.0565,
    inclinationDeg: 2.49,
    ascendingNodeDeg: 113.7,
    argPeriapsisDeg: 339.4,
    meanAnomalyDeg: 317,
    axialTiltDeg: 26.7,
    spinRadPerDay: 0.24,
    massSun: 2.858e-4,
    color: 0xfcd34d,
    surface: "banded",
    oblateness: 0.098,
    displace: 0.018,
    atmosphere: 0xf3e2b8,
    atmoStrength: 0.5,
    hasRings: true,
  },
  {
    id: "uranus",
    nameKo: "천왕성",
    nameEn: "Uranus",
    semiMajorAxisAu: 19.201,
    radiusEarth: 4.007,
    radiusKm: 25362,
    orbitalPeriodDays: 30687,
    massKg: 8.681e25,
    eccentricity: 0.0457,
    inclinationDeg: 0.77,
    ascendingNodeDeg: 74,
    argPeriapsisDeg: 96.9,
    meanAnomalyDeg: 142,
    axialTiltDeg: 97.8,
    spinRadPerDay: 0.1,
    massSun: 4.366e-5,
    color: 0x67e8f9,
    surface: "ice",
    oblateness: 0.023,
    displace: 0.012,
    atmosphere: 0xbff7f2,
    atmoStrength: 0.7,
  },
  {
    id: "neptune",
    nameKo: "해왕성",
    nameEn: "Neptune",
    semiMajorAxisAu: 30.047,
    radiusEarth: 3.883,
    radiusKm: 24622,
    orbitalPeriodDays: 60190,
    massKg: 1.02413e26,
    eccentricity: 0.0113,
    inclinationDeg: 1.77,
    ascendingNodeDeg: 131.8,
    argPeriapsisDeg: 273.2,
    meanAnomalyDeg: 256,
    axialTiltDeg: 28.3,
    spinRadPerDay: 0.12,
    massSun: 5.151e-5,
    color: 0x2563eb,
    surface: "ice",
    oblateness: 0.017,
    displace: 0.016,
    atmosphere: 0x6aa4ff,
    atmoStrength: 0.72,
    spot: true,
  },
];

/** Log chart. Same slope as the original staging, shifted so inner orbits stay outside the sun. */
export function orbitRadiusSceneUnits(au: number): number {
  return 20 + Math.log10(Math.max(au, 0) + 0.05) * 28;
}

export function bodyRadiusSceneUnits(earthRadii: number): number {
  const log = Math.log10(earthRadii + 0.08);
  return Math.max(0.35, 0.55 + log * 2.2);
}

export function sunRadiusSceneUnits(): number {
  return 5.5;
}

export function radiusAu(radiusKm: number): number {
  return radiusKm / KM_PER_AU;
}
