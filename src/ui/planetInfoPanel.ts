import { PLANETS, PlanetDefinition } from "../data/planets";

const EARTH_MASS_KG = 5.9724e24;
const DAYS_PER_YEAR = 365.25;
const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

function superscript(value: number): string {
  return String(value)
    .replace(/-/g, "⁻")
    .replace(/\d/g, (digit) => SUPERSCRIPTS[Number(digit)] ?? digit);
}

export function formatMassKg(massKg: number): string {
  if (!Number.isFinite(massKg) || massKg <= 0) return "—";
  const exponent = Math.floor(Math.log10(massKg));
  const mantissa = massKg / 10 ** exponent;
  const earthMasses = massKg / EARTH_MASS_KG;
  const earthDigits = earthMasses >= 100 ? 1 : earthMasses >= 10 ? 2 : 3;
  const earthText = earthMasses.toFixed(earthDigits);
  return `${mantissa.toFixed(2)}×10${superscript(exponent)} kg (${earthText} M⊕)`;
}

export function formatOrbitalPeriod(days: number): string {
  const dayText = days.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  const years = days / DAYS_PER_YEAR;
  if (years < 1) return `${dayText}일`;
  const yearText = years.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return `${dayText}일 (${yearText}년)`;
}

/** Mean orbital radius in AU. Scene log-scale radius is not used. */
export function formatRealDistanceAu(au: number): string {
  const text = au.toLocaleString("ko-KR", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  return `${text} AU`;
}

function renderPlanet(def: PlanetDefinition): string {
  return `
    <article class="planet-fact" data-planet-id="${def.id}">
      <h4 class="planet-fact-name">${def.nameKo}</h4>
      <dl class="planet-fact-list">
        <div>
          <dt>질량</dt>
          <dd>${formatMassKg(def.massKg)}</dd>
        </div>
        <div>
          <dt>공전 주기</dt>
          <dd>${formatOrbitalPeriod(def.orbitalPeriodDays)}</dd>
        </div>
        <div>
          <dt>실제 거리</dt>
          <dd>${formatRealDistanceAu(def.semiMajorAxisAu)}</dd>
        </div>
      </dl>
    </article>
  `;
}

export class PlanetInfoPanel {
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  show(selectedIds: ReadonlySet<string>): void {
    const selected = PLANETS.filter((planet) => selectedIds.has(planet.id));
    if (selected.length === 0) {
      this.root.innerHTML = `
        <h3>행성 정보</h3>
        <p class="info-empty">행성을 선택하세요.</p>
      `;
      return;
    }

    this.root.innerHTML = `
      <h3>행성 정보</h3>
      ${selected.map(renderPlanet).join("")}
      <p class="scale-note">실제 거리는 화면 로그 스케일이 아닌 평균 궤도 반지름(AU)입니다.</p>
    `;
  }
}
