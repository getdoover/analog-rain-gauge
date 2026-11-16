// BOM radar images → the map.
//
// The processor stores each BOM radar PNG as a `bom_radar` message attachment.
// BOM images aren't in the map's projection: site images are gnomonic
// (centred on the radar) and the national mosaic is Lambert conformal conic.
// Each frame is decoded here into a grid of BOM intensity levels (BOM's
// burned-in header/footer text dropped), and the map's radar layer samples
// that grid for every screen pixel it draws (see components/RadarLayer.ts).

export const RADAR_CHANNEL = "bom_radar";

export type RadarKind = "local" | "national";

export interface RadarMap {
  projection?: string;
  center: [number, number]; // [lon, lat]
  corners: [number, number][]; // [lon, lat]; 0 = bottom-left, 1 = top-left, 2 = top-right, 3 = bottom-right
}

/** The `bom_radar` aggregate the processor maintains. */
export interface RadarState {
  local?: {
    product: string;
    site_id: number;
    name: string;
    range_km: number;
    map: RadarMap;
  } | null;
  national?: { product: string } | null;
  last?: Record<string, number>;
  keep_days?: number;
}

export interface RadarFrame {
  id: string; // message id
  kind: RadarKind;
  product: string;
  time: number; // epoch ms (radar observation time)
  attachmentId: string | null;
}

export interface LatLngBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface SourceProjection {
  /** lon/lat (degrees) → source image pixel (may be out of range). */
  toPixel(lon: number, lat: number): [number, number];
  /** Drop BOM's text overlays (header bar, timestamps, copyright). */
  isText(px: number, py: number, r: number, g: number, b: number): boolean;
  bounds: LatLngBox;
}

const D2R = Math.PI / 180;
const EARTH_KM = 6371;
const SRC_SIZE = 512;

// --- Site images: gnomonic, georeferenced by the four corners in the .map file.
function gnomonic(lon: number, lat: number, lon0: number, lat0: number): [number, number] {
  const f = lat * D2R, l = lon * D2R, f0 = lat0 * D2R, l0 = lon0 * D2R;
  const c = Math.sin(f0) * Math.sin(f) + Math.cos(f0) * Math.cos(f) * Math.cos(l - l0);
  return [
    (EARTH_KM * Math.cos(f) * Math.sin(l - l0)) / c,
    (EARTH_KM * (Math.cos(f0) * Math.sin(f) - Math.sin(f0) * Math.cos(f) * Math.cos(l - l0))) / c,
  ];
}

function siteProjection(map: RadarMap): SourceProjection {
  const [lon0, lat0] = map.center;
  const g = map.corners.map(([lon, lat]) => gnomonic(lon, lat, lon0, lat0));
  const left = (g[0][0] + g[1][0]) / 2;
  const right = (g[2][0] + g[3][0]) / 2;
  const top = (g[1][1] + g[2][1]) / 2;
  const bottom = (g[0][1] + g[3][1]) / 2;
  // Gnomonic edges bow slightly in lat/lon, so box the corners plus margin.
  const lons = map.corners.map((c) => c[0]);
  const lats = map.corners.map((c) => c[1]);
  const padLat = (Math.max(...lats) - Math.min(...lats)) * 0.02;
  const padLon = (Math.max(...lons) - Math.min(...lons)) * 0.02;
  return {
    toPixel(lon, lat) {
      const [x, y] = gnomonic(lon, lat, lon0, lat0);
      return [((x - left) / (right - left)) * SRC_SIZE, ((top - y) / (top - bottom)) * SRC_SIZE];
    },
    isText(_px, py, r, g, b) {
      // 16 px title bar across the top; black text (and grey) elsewhere.
      return py < 16 || (r === 0 && g === 0 && b === 0) || (r === 192 && g === 192 && b === 192);
    },
    bounds: {
      north: Math.max(...lats) + padLat,
      south: Math.min(...lats) - padLat,
      east: Math.max(...lons) + padLon,
      west: Math.min(...lons) - padLon,
    },
  };
}

// --- National mosaic: Lambert conformal conic (standard parallels 18°S / 40°S,
// central meridian 134°E per BOM). BOM doesn't publish the image's placement;
// scale and origin were fitted against the georeferenced site images (~81% of
// site rain pixels land on mosaic rain pixels — the rest is resolution).
const LCC_P1 = -18 * D2R;
const LCC_P2 = -40 * D2R;
const LCC_LAM0 = 134 * D2R;
const LCC_N =
  Math.log(Math.cos(LCC_P1) / Math.cos(LCC_P2)) /
  Math.log(Math.tan(Math.PI / 4 + LCC_P2 / 2) / Math.tan(Math.PI / 4 + LCC_P1 / 2));
const LCC_F = (Math.cos(LCC_P1) * Math.tan(Math.PI / 4 + LCC_P1 / 2) ** LCC_N) / LCC_N;
const NATIONAL_KM_PER_PX = 8.48;
const NATIONAL_X0 = 263.25;
const NATIONAL_Y0 = 1606.0135;

const nationalProjection: SourceProjection = {
  toPixel(lon, lat) {
    const rho = (EARTH_KM * LCC_F) / Math.tan(Math.PI / 4 + (lat * D2R) / 2) ** LCC_N;
    const th = LCC_N * (lon * D2R - LCC_LAM0);
    const x = rho * Math.sin(th);
    const y = -rho * Math.cos(th);
    return [NATIONAL_X0 + x / NATIONAL_KM_PER_PX, NATIONAL_Y0 - y / NATIONAL_KM_PER_PX];
  },
  isText(px, py) {
    // UTC timestamp, bottom-right.
    return py >= 488 && px >= 320;
  },
  bounds: { north: -5.5, south: -44.5, east: 161, west: 106 },
};

export function projectionFor(kind: RadarKind, state: RadarState | undefined): SourceProjection | null {
  if (kind === "national") return nationalProjection;
  const map = state?.local?.map;
  return map ? siteProjection(map) : null;
}

// --- Intensity grids ------------------------------------------------------
// BOM's radar reflectivity levels, light → heavy. Every rain pixel in a BOM
// image is one of these; anything else (text, borders) is ignored.
export const RADAR_LEVELS: [number, number, number][] = [
  [245, 245, 255], [180, 180, 255], [120, 120, 255], [20, 20, 255], [0, 216, 195],
  [0, 150, 144], [0, 102, 102], [255, 255, 0], [255, 200, 0], [255, 150, 0],
  [255, 100, 0], [255, 0, 0], [200, 0, 0], [120, 0, 0], [40, 0, 0],
];
const LEVEL_OF = new Map(RADAR_LEVELS.map(([r, g, b], i) => [(r << 16) | (g << 8) | b, i + 1]));

/** A decoded frame: smoothed BOM intensity level (0 = dry, 1–15) per source pixel. */
export interface RadarGrid {
  levels: Float32Array; // SRC_SIZE × SRC_SIZE
  proj: SourceProjection;
}

// BOM draws the radar's polar bins as blocks several pixels wide; a light
// Gaussian (two passes of a 1-4-6-4-1 kernel, σ ≈ 1.4 px) rounds them into
// rain bands without shifting where the rain is.
const KERNEL = [1, 4, 6, 4, 1].map((k) => k / 16);
function blur(src: Float32Array, passes: number): Float32Array {
  let a: Float32Array = src;
  let b: Float32Array = new Float32Array(a.length);
  const N = SRC_SIZE;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let v = 0;
        for (let k = -2; k <= 2; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < N) v += a[y * N + xx] * KERNEL[k + 2];
        }
        b[y * N + x] = v;
      }
    }
    [a, b] = [b, a];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let v = 0;
        for (let k = -2; k <= 2; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < N) v += a[yy * N + x] * KERNEL[k + 2];
        }
        b[y * N + x] = v;
      }
    }
    [a, b] = [b, a];
  }
  return a;
}

export async function decodeGrid(blob: Blob, proj: SourceProjection): Promise<RadarGrid> {
  const bitmap = await createImageBitmap(blob);
  const src = document.createElement("canvas");
  src.width = bitmap.width;
  src.height = bitmap.height;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const sw = src.width, sh = src.height;
  const sdata = sctx.getImageData(0, 0, sw, sh).data;
  const levels = new Float32Array(SRC_SIZE * SRC_SIZE);
  for (let py = 0; py < SRC_SIZE; py++) {
    for (let px = 0; px < SRC_SIZE; px++) {
      const si = (Math.floor((py * sh) / SRC_SIZE) * sw + Math.floor((px * sw) / SRC_SIZE)) * 4;
      if (sdata[si + 3] === 0) continue;
      const r = sdata[si], g = sdata[si + 1], b = sdata[si + 2];
      if (proj.isText(px, py, r, g, b)) continue;
      levels[py * SRC_SIZE + px] = LEVEL_OF.get((r << 16) | (g << 8) | b) ?? 0;
    }
  }
  return { levels: blur(levels, 2), proj };
}

/**
 * Intensity at a point, bilinearly blended between the four nearest BOM
 * pixels so rain edges are smooth at any zoom (0 outside the image).
 */
export function sampleGrid(grid: RadarGrid, lon: number, lat: number): number {
  const b = grid.proj.bounds;
  if (lat > b.north || lat < b.south || lon > b.east || lon < b.west) return 0;
  const [fx, fy] = grid.proj.toPixel(lon, lat);
  const x = fx - 0.5, y = fy - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < -1 || y0 < -1 || x0 >= SRC_SIZE || y0 >= SRC_SIZE) return 0;
  const tx = x - x0, ty = y - y0;
  const L = grid.levels;
  const at = (xx: number, yy: number) =>
    xx < 0 || yy < 0 || xx >= SRC_SIZE || yy >= SRC_SIZE ? 0 : L[yy * SRC_SIZE + xx];
  return (
    (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) +
    (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
  );
}

// Blended intensity → RGBA. Light rain is drawn more transparent so BOM's
// near-white low levels read as drizzle over satellite imagery, not haze, and
// the dry edge is feathered rather than cut.
const DRY = 0.35;
// Drawn colours: BOM's palette, except its two near-white lightest levels,
// which vanish into satellite imagery, are tinted blue.
const DRAWN_LEVELS: [number, number, number][] = RADAR_LEVELS.map((c, i) =>
  i === 0 ? [175, 195, 255] : i === 1 ? [135, 155, 255] : c,
);
export const RADAR_RGBA: Uint8ClampedArray = (() => {
  // 256 steps across 0..15.
  const out = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const v = (k / 255) * RADAR_LEVELS.length;
    if (v < DRY) continue;
    const lvl = Math.min(RADAR_LEVELS.length, Math.max(1, Math.round(v)));
    const [r, g, bl] = DRAWN_LEVELS[lvl - 1];
    const strength = Math.min(1, 0.4 + 0.12 * (lvl - 1)); // 0.4 light → 1 heavy
    const edge = v >= 1 ? 1 : (v - DRY) / (1 - DRY);
    out.set([r, g, bl, Math.round(255 * strength * edge)], k * 4);
  }
  return out;
})();

export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
export const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R;

// --- Messages ---------------------------------------------------------------
interface RawRadarMessage {
  id: string;
  data?: {
    local?: { product?: string; time?: number };
    national?: { product?: string; time?: number };
  };
  attachments?: { url?: string }[];
}

/** The attachment id is the last path segment of its URL. */
function attachmentIdOf(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0].replace(/\/+$/, "");
  const seg = path.slice(path.lastIndexOf("/") + 1);
  return seg || null;
}

export function toFrame(m: RawRadarMessage): RadarFrame | null {
  const kind: RadarKind | null = m.data?.local ? "local" : m.data?.national ? "national" : null;
  if (!kind) return null;
  const d = m.data![kind]!;
  if (typeof d.time !== "number") return null;
  return {
    id: m.id,
    kind,
    product: d.product ?? "",
    time: d.time,
    attachmentId: attachmentIdOf(m.attachments?.[0]?.url),
  };
}

/** Latest frame at or before `t` (frames sorted oldest first). */
export function frameAt(frames: RadarFrame[], t: number): RadarFrame | null {
  let lo = 0, hi = frames.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best >= 0 ? frames[best] : null;
}
