import { useMemo } from "react";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgentChannel, useDooverClient } from "doover-js/react";
import { generateSnowflakeIdAtTime } from "doover-js";
import dayjs from "dayjs";

import {
  RADAR_CHANNEL,
  projectionFor,
  decodeGrid,
  type RadarGrid,
  sitesOf,
  toFrames,
  type RadarFrame,
  type RadarSite,
  type RadarKind,
  type RadarState,
} from "./radar";

// Message listing caps at 1500 per request; 7 days of 5-minute slots is ~2000,
// so allow a few pages.
const PAGE_LIMIT = 1500;
const MAX_PAGES = 4;

type Client = ReturnType<typeof useDooverClient>;

/** The radar aggregate + every stored frame from `fromMs` to now, oldest first. */
export function useRadarFrames(agentId: string | undefined, fromMs: number) {
  const client = useDooverClient();
  const { data: state, isLoading: stateLoading } = useAgentChannel<RadarState>(agentId, RADAR_CHANNEL);

  const framesQuery = useQuery({
    queryKey: ["bom-radar-frames", agentId, fromMs],
    enabled: !!agentId,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const after = generateSnowflakeIdAtTime(dayjs(fromMs));
      let before = generateSnowflakeIdAtTime(dayjs(Date.now() + 60_000));
      const out: RadarFrame[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const msgs = await client.messages.listMessages(agentId!, RADAR_CHANNEL, {
          after,
          before,
          limit: PAGE_LIMIT,
        });
        for (const m of msgs) out.push(...toFrames(m as never));
        if (msgs.length < PAGE_LIMIT) break;
        // Page older from the oldest id returned.
        before = msgs.reduce((min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min), msgs[0].id);
      }
      return out;
    },
  });

  const sites: RadarSite[] = useMemo(() => sitesOf(state ?? undefined), [state]);
  const { byProduct, national } = useMemo(() => {
    const seen = new Set<string>();
    const all = (framesQuery.data ?? [])
      .filter((f) => {
        const k = `${f.product}@${f.time}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.time - b.time);
    // Only frames of the radars currently configured line up with their maps.
    const byProduct = new Map<string, RadarFrame[]>(sites.map((s) => [s.product, []]));
    for (const f of all) if (f.kind === "local") byProduct.get(f.product)?.push(f);
    return { byProduct, national: all.filter((f) => f.kind === "national") };
  }, [framesQuery.data, sites]);

  return {
    state: state ?? undefined,
    sites,
    byProduct,
    national,
    isLoading: stateLoading || framesQuery.isLoading,
  };
}

function imageQuery(
  client: Client,
  agentId: string | undefined,
  frame: RadarFrame | null,
  state: RadarState | undefined,
) {
  const proj = frame ? projectionFor(frame, state) : null;
  return {
    queryKey: ["bom-radar-grid", frame?.id, frame?.attachmentId, frame?.product],
    enabled: !!agentId && !!frame?.attachmentId && !!proj,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    // Keep showing the last frame while the next one loads.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const blob = (await client.messages.getMessageAttachment(
        agentId!,
        RADAR_CHANNEL,
        frame!.id,
        frame!.attachmentId!,
      )) as Blob;
      return decodeGrid(blob, proj!);
    },
  };
}

/** A frame decoded into BOM intensity levels, ready for the map to draw. */
export function useRadarGrid(
  agentId: string | undefined,
  frame: RadarFrame | null,
  state: RadarState | undefined,
): RadarGrid | null {
  const client = useDooverClient();
  const q = useQuery(imageQuery(client, agentId, frame, state));
  return frame ? q.data ?? null : null;
}

/**
 * Several frames' grids (one per radar), in order. Each slot keeps its
 * radar's previous grid while the next decodes, so the composite doesn't
 * flicker as the slider moves.
 */
export function useRadarGrids(
  agentId: string | undefined,
  frames: (RadarFrame | null)[],
  state: RadarState | undefined,
): RadarGrid[] {
  const client = useDooverClient();
  const results = useQueries({ queries: frames.map((f) => imageQuery(client, agentId, f, state)) });
  const grids = results.map((r, i) => (frames[i] ? r.data ?? null : null)).filter((g): g is RadarGrid => !!g);
  // Stable identity while the set of grids is unchanged.
  const key = grids.map((g) => grids.indexOf(g) + ":" + gridId(g)).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => grids, [key]);
}

const gridIds = new WeakMap<RadarGrid, number>();
let nextGridId = 0;
function gridId(g: RadarGrid): number {
  let id = gridIds.get(g);
  if (id == null) gridIds.set(g, (id = nextGridId++));
  return id;
}

/** Fetch and decode frames ahead of time (cached like useRadarGrid). */
export function usePrefetchRadar() {
  const client = useDooverClient();
  const qc = useQueryClient();
  return (agentId: string | undefined, frames: RadarFrame[], state: RadarState | undefined) => {
    for (const f of frames) void qc.prefetchQuery(imageQuery(client, agentId, f, state));
  };
}

export type { RadarKind };
