import "./styles.css";

import { useEffect, useMemo, useState } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import {
  useAgentChannel,
  useDeviceMap,
  useDooverClient,
  useMultiAgentAggregates,
  type DeviceMapEntry,
} from "doover-js/react";
import { generateSnowflakeIdAtTime } from "doover-js";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

import {
  BOM,
  bomBand,
  bucketPulses,
  periodDays,
  rgb,
  sumWindow,
  timeBins,
  type Period,
  type PulseSample,
} from "./lib/rainfall";
import RainfallMap, { type MapGauge } from "./components/RainfallMap";
import RainfallTimeline, { type TimelineSeries } from "./components/RainfallTimeline";

dayjs.extend(relativeTime);

// A gauge counts as "reporting" if we've heard from it within this window.
const REPORTING_WINDOW_MS = 6 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface UiRemoteComponentRainfall {
  app_key: string; // the dashboard app's own key — DEVICE_MAP lives under it
}

interface RainDeviceEntry extends DeviceMapEntry {
  app_installs?: Array<{
    name?: string | null;
    application_name?: string | null;
  }>;
}

/** `tag_values` aggregate shape: `{ <app_key>: { <tag>: value } }`. */
type TagValuesAggregate = Record<string, Record<string, unknown> | undefined>;

/** The bits of a `pulse` rain message we read from the batch endpoint. Each
 *  pulse is one tip of the gauge: `mm` of rain at epoch-ms `timestamp`. */
interface PulseMessage {
  id: string;
  timestamp?: number;
  channel?: { agent_id?: string };
  data?: { pulse?: { mm?: number; timestamp?: number } };
}

// Stable empty array so an unloaded query doesn't churn downstream memos.
const EMPTY_PULSES: PulseMessage[] = [];

// Pulse fetch bounds: paginate older within the window until drained, capped so
// an extreme-rainfall gauge can't fan out unboundedly.
const PULSE_PAGE_LIMIT = 500; // messages per agent per request
const MAX_PULSE_PAGES = 6;

interface DashboardDeploymentConfig {
  applications?: Record<
    string,
    {
      gauge_app_name?: string | null;
      farm_name?: string | null;
      ignored_groups?: string[] | null;
    } & Record<string, unknown>
  >;
}

interface GaugeRow {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  total: number; // mm over the selected time window
  hasData: boolean; // reporting, or has pulses in the period
  reporting: boolean;
  lastSeenMs: number | null;
  color: string; // BOM band colour for the window total (map pin + table dot)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function displayNameOf(d: RainDeviceEntry): string {
  if (typeof d.display_name === "string" && d.display_name) return d.display_name;
  if (typeof d.name === "string" && d.name) return d.name;
  return d.id;
}

/** The data channel for a gauge: its install whose application_name matches the
 *  configured gauge app, else the configured app name itself. */
function gaugeChannel(d: RainDeviceEntry, gaugeAppName: string): string {
  const installs = Array.isArray(d.app_installs) ? d.app_installs : [];
  for (const inst of installs) {
    if (inst?.application_name === gaugeAppName && typeof inst.name === "string" && inst.name) {
      return inst.name;
    }
  }
  return gaugeAppName;
}

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

/** "Last seen" label — always in the past, so collapse anything within ~a
 *  minute (or a slightly-future timestamp from clock skew) to "now" instead of
 *  dayjs's "in a few seconds" / "a few seconds ago". */
function lastSeenLabel(ms: number | null): string {
  if (ms == null) return "never";
  if (Date.now() - ms < 60_000) return "now";
  return dayjs(ms).fromNow();
}

/** True on phone-width viewports — used to drop the "Last seen" table column. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

// ---------------------------------------------------------------------------
// Small presentational helpers (inline-styled against the host theme vars)
// ---------------------------------------------------------------------------
function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "var(--card)",
        color: "var(--card-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius, 10px)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: ".06em",
        color: "var(--muted-foreground)",
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function StatTile({
  eyebrow,
  value,
  sub,
}: {
  eyebrow: string;
  value: React.ReactNode;
  sub: React.ReactNode;
}) {
  return (
    <Card style={{ gap: 6 }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 600, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted-foreground)", display: "flex", alignItems: "center", gap: 6 }}>
        {sub}
      </div>
    </Card>
  );
}

function ColorDot({ color, muted }: { color: string; muted?: boolean }) {
  return (
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: 999,
        background: color,
        display: "inline-block",
        flexShrink: 0,
        boxShadow: "0 0 0 1px rgba(0,0,0,.18)",
        opacity: muted ? 0.5 : 1,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Inner widget
// ---------------------------------------------------------------------------
function RainfallDashboardWidgetInner({ uiElement }: { uiElement: UiRemoteComponentRainfall }) {
  const params = useRemoteParams();
  const agentId = params?.agentId;
  const dashboardAppKey = uiElement?.app_key ?? "";

  const [period, setPeriod] = useState<Period>("7d");

  // 1. DEVICE_MAP — every gauge this dashboard can see, with location + installs.
  const { devices: allDevices, isLoading: cfgLoading } = useDeviceMap<RainDeviceEntry>(
    agentId,
    dashboardAppKey,
  );

  // Dashboard's own configured options live in the same deployment_config channel.
  const { data: deploymentConfig } = useAgentChannel<DashboardDeploymentConfig>(
    agentId,
    "deployment_config",
  );
  const appCfg = deploymentConfig?.applications?.[dashboardAppKey];
  const gaugeAppName = (typeof appCfg?.gauge_app_name === "string" && appCfg.gauge_app_name) || "analog_rain_gauge";
  const farmName = (typeof appCfg?.farm_name === "string" && appCfg.farm_name.trim()) || "All gauges";

  const ignoreGroupIds = useMemo(() => {
    const raw = appCfg?.ignored_groups;
    if (!Array.isArray(raw)) return null;
    const s = new Set<string>();
    for (const v of raw) {
      if (typeof v === "string" && v) s.add(v);
      else if (typeof v === "number" && Number.isFinite(v)) s.add(String(v));
    }
    return s.size > 0 ? s : null;
  }, [appCfg]);

  const devices = useMemo(() => {
    if (!ignoreGroupIds) return allDevices;
    return allDevices.filter((d) => {
      const gid = d.group?.id;
      return gid == null || !ignoreGroupIds.has(String(gid));
    });
  }, [allDevices, ignoreGroupIds]);
  const deviceIds = useMemo(() => devices.map((d) => d.id), [devices]);

  // Each gauge's data channel = its install whose application_name matches the
  // configured gauge app (falls back to the app name itself). Usually uniform
  // (the gauge app is allow_many=false), but we resolve per-device so a mixed
  // fleet still works.
  const channelByDevice = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of devices) m[d.id] = gaugeChannel(d, gaugeAppName);
    return m;
  }, [devices, gaugeAppName]);
  const uniqueChannels = useMemo(
    () => [...new Set(Object.values(channelByDevice))],
    [channelByDevice],
  );
  // The single channel the batched pulse read fans out over — the most common
  // one across the fleet (every gauge in the uniform case).
  const dataChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of Object.values(channelByDevice)) counts.set(c, (counts.get(c) ?? 0) + 1);
    let best = gaugeAppName;
    let bestN = -1;
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
    return best;
  }, [channelByDevice, gaugeAppName]);

  // 2. live tag_values across the fleet — used only for "last seen" / reporting
  //    status now (rainfall totals come from the raw pulses below).
  const { aggregatesByAgent: tagAggs, query: tagQuery } = useMultiAgentAggregates<TagValuesAggregate>(
    "tag_values",
    deviceIds,
    { fields: uniqueChannels.length > 0 ? uniqueChannels : [gaugeAppName] },
  );

  // Stable "now" + the timeline's buckets for the selected period. Pinned at
  // mount so the bins (and the pulse query window) don't churn every render.
  const nowMs = useMemo(() => Date.now(), []);
  const bins = useMemo(() => timeBins(period, new Date(nowMs)), [period, nowMs]);

  // Selected time window as an inclusive [startIdx, endIdx] over the bins. The
  // brush in the timeline drives this, and it also drives the map. Reset to the
  // full span whenever the period (and thus the bin count) changes.
  const [selection, setSelection] = useState<[number, number]>(() => {
    const b = timeBins("7d");
    return [0, b.length - 1];
  });
  useEffect(() => {
    setSelection([0, Math.max(0, bins.length - 1)]);
  }, [period, bins.length]);

  // 3. raw pulse events for the whole fleet across the period window. Each pulse
  //    is one tip of the gauge ({ mm, timestamp }). We bound the read to the
  //    timeline's span via `after`, then paginate older per-agent (using the
  //    server's `next_cursors`) until the window is drained or we hit the cap.
  const client = useDooverClient();
  const windowStartMs = bins.length > 0 ? bins[0].start : nowMs - periodDays(period) * 86_400_000;
  const pulseQuery = useQuery({
    queryKey: ["rainfall-pulses", dataChannel, [...deviceIds].sort().join(","), period],
    enabled: deviceIds.length > 0 && !!dataChannel && bins.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const after = generateSnowflakeIdAtTime(dayjs(windowStartMs));
      const before = generateSnowflakeIdAtTime(dayjs(nowMs + 60_000));
      const byId = new Map<string, PulseMessage>();
      let agentIds = [...deviceIds];
      let agentBefore: string[] | undefined;
      for (let page = 0; page < MAX_PULSE_PAGES && agentIds.length > 0; page++) {
        const res = await client.agents.getMultiAgentMessages(dataChannel, {
          agent_id: agentIds,
          after,
          // First page bounds with the global `before`; later pages resume each
          // still-unfinished agent from its own cursor.
          ...(agentBefore ? { agent_before: agentBefore } : { before }),
          agent_message_limit: PULSE_PAGE_LIMIT,
          field_name: ["pulse"],
        });
        for (const m of (res.results ?? []) as unknown as PulseMessage[]) byId.set(m.id, m);
        const cursors = res.next_cursors;
        if (!cursors || Object.keys(cursors).length === 0) break;
        agentIds = Object.keys(cursors);
        agentBefore = agentIds.map((id) => cursors[id]);
      }
      return [...byId.values()];
    },
  });
  const pulseMessages = pulseQuery.data ?? EMPTY_PULSES;

  // pulse messages → per-device PulseSample[] (ms timestamp + mm).
  const pulsesByDevice = useMemo(() => {
    const out: Record<string, PulseSample[]> = {};
    for (const m of pulseMessages) {
      const id = m.channel?.agent_id;
      const p = m.data?.pulse;
      if (!id || !p) continue;
      const ts = typeof p.timestamp === "number" ? p.timestamp : null;
      const mm = typeof p.mm === "number" ? p.mm : null;
      if (ts == null || mm == null) continue;
      (out[id] ??= []).push({ ts, mm });
    }
    return out;
  }, [pulseMessages]);

  // Per-gauge stacked-timeline series: mm bucketed into the bins, one colour
  // per gauge (stable by device order).
  const series = useMemo<TimelineSeries[]>(
    () =>
      devices.map((d) => ({
        id: d.id,
        name: displayNameOf(d),
        binMm: bucketPulses(pulsesByDevice[d.id] ?? [], bins),
      })),
    [devices, pulsesByDevice, bins],
  );

  // Selection clamped to the current bins — guards the one frame after a period
  // switch where `selection` (reset by an effect) can still point past the new,
  // shorter bin range.
  const sel = useMemo<[number, number]>(() => {
    const last = Math.max(0, bins.length - 1);
    return [Math.min(selection[0], last), Math.min(selection[1], last)];
  }, [selection, bins.length]);

  // Per-gauge rainfall within the selected window (sum of the bin slice).
  const windowTotals = useMemo(() => {
    const [s, e] = sel;
    const out: Record<string, number> = {};
    for (const ser of series) out[ser.id] = sumWindow(ser.binMm, s, e);
    return out;
  }, [series, sel]);

  // 4. assemble the per-gauge rows
  const rows = useMemo<GaugeRow[]>(() => {
    return devices.map((dev) => {
      const tagAgg = tagAggs[dev.id];
      const lastSeenMs = tagAgg?.last_updated ?? null;
      const reporting = lastSeenMs != null && nowMs - lastSeenMs < REPORTING_WINDOW_MS;
      const hasPulses = (pulsesByDevice[dev.id]?.length ?? 0) > 0;
      return {
        id: dev.id,
        name: displayNameOf(dev),
        lat: num(dev.latitude),
        lng: num(dev.longitude),
        total: windowTotals[dev.id] ?? 0,
        hasData: reporting || hasPulses,
        reporting,
        lastSeenMs,
        color: rgb(bomBand(windowTotals[dev.id] ?? 0)),
      };
    });
  }, [devices, tagAggs, windowTotals, pulsesByDevice, nowMs]);

  // Stats over gauges we've actually heard from (reporting, or with pulses).
  const withData = useMemo(() => rows.filter((r) => r.hasData), [rows]);
  const stats = useMemo(() => {
    if (withData.length === 0) return null;
    const totals = withData.map((r) => r.total);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const wettest = withData.reduce((a, b) => (b.total > a.total ? b : a));
    const driest = withData.reduce((a, b) => (b.total < a.total ? b : a));
    return { avg, wettest, driest };
  }, [withData]);

  const reportingCount = useMemo(() => rows.filter((r) => r.reporting).length, [rows]);
  const narrow = useIsNarrow(); // phone width → drop the "Last seen" table column

  const dec = 1;
  const fmt = (v: number) => v.toFixed(dec);

  // Map gauges: every located gauge, coloured per-gauge, sized by window rain.
  const mapGauges = useMemo<MapGauge[]>(
    () =>
      rows
        .filter((r) => r.lat != null && r.lng != null)
        .map((r) => ({
          id: r.id,
          name: r.name,
          lat: r.lat as number,
          lng: r.lng as number,
          mm: r.total,
          mmLabel: fmt(r.total),
          color: r.color,
          reporting: r.reporting,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );

  // Timeline / window summary.
  const binUnit = period === "today" ? "hour" : period === "7d" ? "6 hours" : "day";
  const windowLabel =
    bins.length > 0 ? `${bins[sel[0]]?.full} – ${bins[sel[1]]?.full}` : "";
  const windowTotalAll = useMemo(
    () => Object.values(windowTotals).reduce((s, v) => s + v, 0),
    [windowTotals],
  );
  const hasAnyRain = useMemo(
    () => series.some((s) => s.binMm.some((v) => v > 0)),
    [series],
  );

  // The full BOM rainfall-totals scale (every band) for the map legend.
  const legendCells = useMemo(() => BOM.map(([from, c]) => ({ color: rgb(c), from })), []);

  if (cfgLoading || (deviceIds.length > 0 && (tagQuery.isLoading || pulseQuery.isLoading) && withData.length === 0)) {
    return <div style={{ padding: 16, fontSize: 14, color: "var(--muted-foreground)" }}>Loading rainfall data…</div>;
  }

  if (deviceIds.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 14, color: "var(--muted-foreground)" }}>
        No rain gauges granted to this dashboard yet. Set <strong>Apps Installed</strong> to the Analog Rain Gauge app in
        this dashboard's config.
      </div>
    );
  }

  return (
    <div style={{ background: "var(--muted)", padding: 20, borderRadius: "var(--radius, 10px)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
          <div>
            <Eyebrow>Rainfall</Eyebrow>
            <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}>{farmName}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--muted-foreground)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--doover-connection-online, #22c55e)", display: "inline-block" }} />
              {reportingCount}/{rows.length} reporting
            </span>
            <PeriodToggle period={period} onChange={setPeriod} />
          </div>
        </div>

        {/* Stat tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(178px,1fr))", gap: 12 }}>
          <StatTile
            eyebrow="Average"
            value={stats ? <>{fmt(stats.avg)} <Unit /></> : "—"}
            sub={`across ${withData.length} gauges · selected window`}
          />
          <StatTile
            eyebrow="Wettest gauge"
            value={stats ? <>{fmt(stats.wettest.total)} <Unit /></> : "—"}
            sub={stats ? <><ColorDot color={stats.wettest.color} />{stats.wettest.name}</> : "—"}
          />
          <StatTile
            eyebrow="Driest gauge"
            value={stats ? <>{fmt(stats.driest.total)} <Unit /></> : "—"}
            sub={stats ? <><ColorDot color={stats.driest.color} />{stats.driest.name}</> : "—"}
          />
        </div>

        {/* Map */}
        <Card style={{ padding: 0, gap: 0, overflow: "hidden" }}>
          {mapGauges.length === 0 ? (
            <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 13, color: "var(--muted-foreground)" }}>
              No gauges have a location set, so the map can't be drawn. Set each gauge's location on its device to place it
              here.
            </div>
          ) : (
            <RainfallMap gauges={mapGauges} height={520} />
          )}
          {/* Legend — the full BOM rainfall-totals scale (amount of rain) */}
          <div style={{ padding: "13px 16px", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Eyebrow>Rainfall · BOM scale</Eyebrow>
                <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>mm</span>
              </div>
              <div style={{ display: "flex", height: 10, borderRadius: 3, overflow: "hidden", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.12)" }}>
                {legendCells.map((c, i) => (
                  <div key={i} style={{ flex: 1, background: c.color }} />
                ))}
              </div>
              <div style={{ display: "flex" }}>
                {legendCells.map((c, i) => (
                  <div key={i} style={{ flex: 1, fontSize: 10, color: "var(--muted-foreground)" }}>{c.from}</div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        {/* Rainfall over time — stacked by gauge, with a draggable time window */}
        <Card style={{ gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Rainfall over time</div>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                stacked by gauge · mm per {binUnit} · drag the handles to set the window
              </div>
            </div>
            <span style={{ fontSize: 11, color: "var(--muted-foreground)", fontVariantNumeric: "tabular-nums" }}>
              {windowLabel}
            </span>
          </div>

          {!hasAnyRain ? (
            <div style={{ padding: "30px 8px", textAlign: "center", fontSize: 13, color: "var(--muted-foreground)" }}>
              No rainfall recorded across the gauges in this period.
            </div>
          ) : (
            <RainfallTimeline
              bins={bins}
              series={series}
              selection={sel}
              onSelectionChange={setSelection}
            />
          )}

          <div style={{ fontSize: 11, color: "var(--muted-foreground)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
            <span style={{ display: "block", marginBottom: 6 }}>
              Each bar is stacked per gauge and shaded by the BOM scale above (hover a segment for the gauge).
            </span>
            Rain in window{" "}
            <span style={{ color: "var(--foreground)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {windowTotalAll.toFixed(dec)} mm
            </span>{" "}
            across all gauges · average{" "}
            <span style={{ color: "var(--foreground)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {stats ? fmt(stats.avg) : "0"} mm
            </span>
          </div>
        </Card>

        {/* Per-gauge table */}
        <div>
          <Card style={{ padding: 0, gap: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Rain gauges</div>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>selected window</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--muted-foreground)", fontSize: 11, textAlign: "left" }}>
                  <th style={{ padding: "6px 16px", fontWeight: 500 }}>Gauge</th>
                  <th style={{ padding: "6px 16px", fontWeight: 500, textAlign: "right" }}>Rain</th>
                  {!narrow && <th style={{ padding: "6px 16px", fontWeight: 500, textAlign: "right" }}>Last seen</th>}
                </tr>
              </thead>
              <tbody>
                {sortRows(rows).map((g) => (
                  <tr key={g.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <ColorDot color={g.color} muted={!g.hasData} />
                        <span style={{ fontWeight: 500 }}>{g.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: "8px 16px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {!g.hasData ? <span style={{ color: "var(--muted-foreground)" }}>—</span> : `${fmt(g.total)} mm`}
                    </td>
                    {!narrow && (
                      <td style={{ padding: "8px 16px", textAlign: "right" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, justifyContent: "flex-end" }}>
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: 999,
                              background: g.reporting ? "var(--doover-connection-online, #22c55e)" : "var(--muted-foreground)",
                              display: "inline-block",
                            }}
                          />
                          <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
                            {lastSeenLabel(g.lastSeenMs)}
                          </span>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Unit() {
  return <span style={{ fontSize: 13, color: "var(--muted-foreground)", fontWeight: 500 }}>mm</span>;
}

function PeriodToggle({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  return (
    <div style={{ display: "inline-flex", background: "var(--secondary)", border: "1px solid var(--border)", borderRadius: 9, padding: 3, gap: 2 }}>
      {PERIODS.map((p) => {
        const active = p.key === period;
        return (
          <button
            key={p.key}
            onClick={() => onChange(p.key)}
            style={{
              fontSize: 12,
              fontWeight: 500,
              padding: "4px 10px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              background: active ? "var(--primary)" : "transparent",
              color: active ? "var(--primary-foreground)" : "var(--muted-foreground)",
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/** Sort: reporting gauges with data first (wettest → driest), then the rest. */
function sortRows(rows: GaugeRow[]): GaugeRow[] {
  return [...rows].sort((a, b) => {
    if ((a.total == null) !== (b.total == null)) return a.total == null ? 1 : -1;
    if (a.total != null && b.total != null && a.total !== b.total) return b.total - a.total;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

// ---------------------------------------------------------------------------
// Wrapper — provides the query client + doover context the hooks need.
// ---------------------------------------------------------------------------
const RainfallDashboardWidget = (props: any) => (
  <RemoteComponentWrapper>
    <RainfallDashboardWidgetInner {...props} />
  </RemoteComponentWrapper>
);

export default RainfallDashboardWidget;
