# Universe Simulator

Client-only solar system simulation (Sun + Mercury–Neptune) built with Vite, TypeScript, and Three.js. Deploy as a static site on **Cloudflare Pages**.

## Develop

```bash
cd universe-simulator
npm install
npm run dev
```

Open the URL Vite prints (default `http://127.0.0.1:5173`).

## Build

```bash
npm run build
npm run preview
```

## Cloudflare Pages

| Setting | Value |
|--------|--------|
| Root directory | repo root (this repository) |
| Build command | `npm ci && npm run build` |
| Output directory | `dist` |
| Node | 22 |

Alternative CLI:

```bash
npm run build
npx wrangler pages deploy dist --project-name universe-simulator
```

## Scale conventions

Orbital radii use `20 + log10(AU + 0.05) × 28` scene units (same log slope as before, shifted so Mercury stays outside the Sun). Planet sizes use a logarithmic compression of Earth-radius ratios. Planet positions are Keplerian in true AU (eccentricity and inclination included) and then log-mapped for display. Only meteors and impact debris are integrated. Lighting is exposed for Earth, with a terminator, eclipses, and a Saturn ring shadow. The renderer is Three.js `WebGPURenderer`, falling back to its WebGL2 backend when WebGPU is unavailable.

## Tools

- Select / multi-select (Shift+click)
- Destroy, meteor impact, restore one, reset all, undo
- Procedural Web Audio cues for select, meteor impact, and destroy (no audio files)
- Time scale 0.25×–100× and pause
- Orbit / pan / zoom camera; double-click a planet in the list to focus