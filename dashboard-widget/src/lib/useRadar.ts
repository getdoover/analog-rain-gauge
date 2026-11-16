import { useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAgentChannel, useDooverClient } from "doover-js/react";
import { generateSnowflakeIdAtTime } from "doover-js";
import dayjs from "dayjs";

import {
  RADAR_CHANNEL,
  projectionFor,
  reproject,
  toFrame,
  type RadarFrame,
  type RadarKind,
  type RadarState,
} from "./radar";

// Message listing caps at 1500 per request; 7 days of 5-minute local frames is
// ~2000, so allow a few pages.
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
        for (const m of msgs) {
          const f = toFrame(m as never);
          if (f) out.push(f);
        }
        if (msgs.length < PAGE_LIMIT) break;
        // Page older from the oldest id returned.
        before = msgs.reduce((min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min), msgs[0].id);
      }
      return out;
    },
  });

  const { local, national } = useMemo(() => {
    const byId = new Map<string, RadarFrame>();
    for (const f of framesQuery.data ?? []) byId.set(f.id, f);
    const all = [...byId.values()].sort((a, b) => a.time - b.time);
    const localProduct = state?.local?.product;
    return {
      // Only frames of the currently configured site/range line up with its map.
      local: all.filter((f) => f.kind === "local" && (!localProduct || f.product === localProduct)),
      national: all.filter((f) => f.kind === "national"),
    };
  }, [framesQuery.data, state?.local?.product]);

  return {
    state: state ?? undefined,
    local,
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
  const proj = frame ? projectionFor(frame.kind, state) : null;
  return {
    queryKey: ["bom-radar-image", frame?.id, frame?.kind === "local" ? state?.local?.product : "national"],
    enabled: !!agentId && !!frame?.attachmentId && !!proj,
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      const blob = (await client.messages.getMessageAttachment(
        agentId!,
        RADAR_CHANNEL,
        frame!.id,
        frame!.attachmentId!,
      )) as Blob;
      return reproject(blob, proj!);
    },
  };
}

/** A frame's reprojected overlay image (data URL) plus its bounds. */
export function useRadarImage(
  agentId: string | undefined,
  frame: RadarFrame | null,
  state: RadarState | undefined,
) {
  const client = useDooverClient();
  const q = useQuery(imageQuery(client, agentId, frame, state));
  const proj = frame ? projectionFor(frame.kind, state) : null;
  return {
    url: q.data ?? null,
    bounds: proj?.bounds ?? null,
    isLoading: q.isLoading && q.fetchStatus !== "idle",
    error: q.error,
  };
}

/** Warm the cache for frames about to be shown (during playback). */
export function usePrefetchRadar() {
  const client = useDooverClient();
  const qc: QueryClient = useQueryClient();
  return (agentId: string | undefined, frames: RadarFrame[], state: RadarState | undefined) => {
    for (const f of frames) void qc.prefetchQuery(imageQuery(client, agentId, f, state));
  };
}

export type { RadarKind };
