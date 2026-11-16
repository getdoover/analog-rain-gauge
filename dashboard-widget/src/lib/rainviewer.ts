// RainViewer radar tiles (https://www.rainviewer.com/api/weather-maps-api.html).
//
// The free API serves the last ~2 hours of composite radar (BOM's radars, for
// Australia) as Web Mercator tiles, 10 minutes apart, up to zoom 7 only, in
// one colour scheme. Tiles are already smoothed, so they look far better than
// BOM's public FTP images; the dashboard uses them for recent times and falls
// back to its stored BOM frames for anything older.

import { useQuery } from "@tanstack/react-query";

const INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
/** Highest zoom the free API serves; deeper zooms stretch these tiles. */
export const RAINVIEWER_MAX_ZOOM = 7;
export const RAINVIEWER_TILE_SIZE = 512;
/** Each frame covers the 10 minutes from its time. */
export const RAINVIEWER_STEP_MS = 10 * 60_000;

export interface RainViewerFrame {
  time: number; // epoch ms
  /** URL for a tile: `{z}`, `{x}`, `{y}` substituted by the layer. */
  template: string;
}

interface WeatherMaps {
  host: string;
  radar?: { past?: { time: number; path: string }[] };
}

export function useRainViewerFrames(enabled = true) {
  return useQuery({
    queryKey: ["rainviewer-frames"],
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<RainViewerFrame[]> => {
      const res = await fetch(INDEX_URL);
      if (!res.ok) throw new Error(`RainViewer index ${res.status}`);
      const j = (await res.json()) as WeatherMaps;
      return (j.radar?.past ?? [])
        .map((f) => ({
          time: f.time * 1000,
          // colour 2 (the free tier serves one scheme regardless); 1_0 = smoothed, no snow.
          template: `${j.host}${f.path}/${RAINVIEWER_TILE_SIZE}/{z}/{x}/{y}/2/1_0.png`,
        }))
        .sort((a, b) => a.time - b.time);
    },
  });
}

/** The frame showing time `t`, if RainViewer still has it. */
export function rainViewerFrameAt(frames: RainViewerFrame[] | undefined, t: number): RainViewerFrame | null {
  if (!frames?.length) return null;
  let best: RainViewerFrame | null = null;
  for (const f of frames) if (f.time <= t) best = f;
  if (!best) return null;
  // The newest frame stands until the next one is published (they lag ~10–20 min).
  const limit = best === frames[frames.length - 1] ? 3 * RAINVIEWER_STEP_MS : RAINVIEWER_STEP_MS;
  return t - best.time < limit ? best : null;
}
