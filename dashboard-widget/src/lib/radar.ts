// BOM radar images → Google Maps overlays.
//
// The processor stores each BOM radar PNG as a `bom_radar` message attachment.
// BOM images aren't in the map's projection: site images are gnomonic
// (centred on the radar) and the national mosaic is Lambert conformal conic.
// So each frame is reprojected here, pixel by pixel, onto a canvas that is
// linear in Web Mercator — what a google.maps.GroundOverlay stretches between
// its bounds — and BOM's burned-in header/footer text is dropped on the way.

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

interface SourceProjection {
  /** lon/lat (degrees) → source image pixel (may be out of range). */
  toPixel(lon: number, lat: number): [number, number];
  /** Drop BOM's text overlays (header bar, timestamps, copyright). */
  isText(px: number, py: number, r: number, g: number, b: number): boolean;
  bounds: LatLngBox;
  outWidth: number;
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
    outWidth: 640,
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
  outWidth: 900,
};

export function projectionFor(kind: RadarKind, state: RadarState | undefined): SourceProjection | null {
  if (kind === "national") return nationalProjection;
  const map = state?.local?.map;
  return map ? siteProjection(map) : null;
}

// --- Reprojection ---------------------------------------------------------
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
const invMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R;

/** Reproject a BOM PNG into a Web-Mercator-linear PNG data URL over `proj.bounds`. */
export async function reproject(blob: Blob, proj: SourceProjection): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const src = document.createElement("canvas");
  src.width = bitmap.width;
  src.height = bitmap.height;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const sw = src.width, sh = src.height;
  const sdata = sctx.getImageData(0, 0, sw, sh).data;
  const scaleX = sw / SRC_SIZE, scaleY = sh / SRC_SIZE;

  const { north, south, east, west } = proj.bounds;
  const yTop = mercY(north), yBottom = mercY(south);
  const W = proj.outWidth;
  const H = Math.max(1, Math.round((W * (yTop - yBottom)) / ((east - west) * D2R)));
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const octx = out.getContext("2d")!;
  const img = octx.createImageData(W, H);
  const od = img.data;

  const lons = new Float64Array(W);
  for (let i = 0; i < W; i++) lons[i] = west + ((i + 0.5) / W) * (east - west);

  for (let j = 0; j < H; j++) {
    const lat = invMercY(yTop + ((j + 0.5) / H) * (yBottom - yTop));
    for (let i = 0; i < W; i++) {
      const [fx, fy] = proj.toPixel(lons[i], lat);
      const px = Math.floor(fx), py = Math.floor(fy);
      if (px < 0 || py < 0 || px >= SRC_SIZE || py >= SRC_SIZE) continue;
      const si = (Math.floor(py * scaleY) * sw + Math.floor(px * scaleX)) * 4;
      const a = sdata[si + 3];
      if (a === 0) continue;
      const r = sdata[si], g = sdata[si + 1], b = sdata[si + 2];
      if (proj.isText(px, py, r, g, b)) continue;
      const oi = (j * W + i) * 4;
      od[oi] = r;
      od[oi + 1] = g;
      od[oi + 2] = b;
      od[oi + 3] = a;
    }
  }
  octx.putImageData(img, 0, 0);
  return out.toDataURL("image/png");
}

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
