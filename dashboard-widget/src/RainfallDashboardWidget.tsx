import "./styles.css";

import { useMemo, useState } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import {
  useAgentChannel,
  useDeviceMap,
  useMultiAgentAggregates,
  useMultiAgentChannelMessages,
  type DeviceMapEntry,
} from "doover-js/react";
import { generateSnowflakeIdAtTime } from "doover-js";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

import {
  DAY_MS,
  bomBand,
  BOM,
  farmDailyAverages,
  gaugePeriodTotal,
  periodDays,
  rgb,
  type DayBar,
  type Period,
} from "./lib/rainfall";
import RainfallMap, { type MapGauge } from "./components/RainfallMap";

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
  total: number | null; // mm over the selected period (null = no data)
  reporting: boolean;
  lastSeenMs: number | null;
  color: string; // BOM band colour for the period total
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

function periodLabel(p: Period): string {
  return p === "today" ? "today" : p === "7d" ? "last 7 days" : "last 30 days";
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
  const farmName = (typeof appCfg?.farm_name === "string" && appCfg.farm_name.trim()) || "Farm";

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
  // The single channel the batched daily-totals read fans out over — the most
  // common one across the fleet (every gauge in the uniform case).
  const dailyChannel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of Object.values(channelByDevice)) counts.set(c, (counts.get(c) ?? 0) + 1);
    let best = gaugeAppName;
    let bestN = -1;
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
    return best;
  }, [channelByDevice, gaugeAppName]);

  // 2. live tag_values across the fleet — today's `since_9am` per gauge. Project
  //    only the gauge channels' subtrees out of the (potentially large) aggregate.
  const { aggregatesByAgent: tagAggs, query: tagQuery } = useMultiAgentAggregates<TagValuesAggregate>(
    "tag_values",
    deviceIds,
    { fields: uniqueChannels.length > 0 ? uniqueChannels : [gaugeAppName] },
  );

  // 3. daily rainfall totals for the whole fleet over the last 30 days, in one
  //    batched read. `daily` messages carry { date, total_mm }.
  const top = useMemo(() => Date.now() + 60_000, []);
  const beforeCursor = useMemo(() => generateSnowflakeIdAtTime(dayjs(top)), [top]);
  const afterCursor = useMemo(
    () => generateSnowflakeIdAtTime(dayjs(top - 31 * DAY_MS)),
    [top],
  );
  const dailyQuery = useMultiAgentChannelMessages<{ daily?: { date?: string; total_mm?: number } }>(
    dailyChannel,
    deviceIds,
    {
      fields: ["daily"],
      initialBefore: beforeCursor,
      after: afterCursor,
      agentMessageLimit: 40,
      liveUpdates: false,
    },
  );

  // daily messages → per-device Map<dateKey, mm>
  const dailyByDevice = useMemo(() => {
    const out: Record<string, Map<string, number>> = {};
    for (const m of dailyQuery.messages) {
      const id = (m.channel as { agent_id?: string } | undefined)?.agent_id;
      if (!id) continue;
      const daily = (m.data as { daily?: { date?: string; total_mm?: number } } | undefined)?.daily;
      const date = daily?.date;
      const mm = daily?.total_mm;
      if (typeof date === "string" && typeof mm === "number") {
        (out[id] ??= new Map()).set(date, mm);
      }
    }
    return out;
  }, [dailyQuery.messages]);

  // 4. assemble the per-gauge rows
  const rows = useMemo<GaugeRow[]>(() => {
    const now = new Date();
    const nowMs = now.getTime();
    return devices.map((dev) => {
      const channel = channelByDevice[dev.id] ?? gaugeAppName;
      const tagAgg = tagAggs[dev.id];
      const todayMm = num(tagAgg?.data?.[channel]?.since_9am);
      const dailyByDate = dailyByDevice[dev.id] ?? new Map<string, number>();
      const total = gaugePeriodTotal(dailyByDate, todayMm, period, now);
      const lastSeenMs = tagAgg?.last_updated ?? null;
      const reporting = lastSeenMs != null && nowMs - lastSeenMs < REPORTING_WINDOW_MS;
      return {
        id: dev.id,
        name: displayNameOf(dev),
        lat: num(dev.latitude),
        lng: num(dev.longitude),
        total,
        reporting,
        lastSeenMs,
        color: rgb(bomBand(total ?? 0)),
      };
    });
  }, [devices, tagAggs, dailyByDevice, channelByDevice, gaugeAppName, period]);

  // Stats over gauges that actually have a reading this period.
  const withData = useMemo(() => rows.filter((r) => r.total != null), [rows]);
  const stats = useMemo(() => {
    if (withData.length === 0) return null;
    const totals = withData.map((r) => r.total as number);
    const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
    const wettest = withData.reduce((a, b) => ((b.total as number) > (a.total as number) ? b : a));
    const driest = withData.reduce((a, b) => ((b.total as number) < (a.total as number) ? b : a));
    return {
      avg,
      wettest,
      driest,
      spread: (wettest.total as number) - (driest.total as number),
    };
  }, [withData]);

  const reportingCount = useMemo(() => rows.filter((r) => r.reporting).length, [rows]);

  const dec = period === "30d" ? 0 : 1;
  const fmt = (v: number) => v.toFixed(dec);

  // Map gauges: those with a location and a reading this period.
  const mapGauges = useMemo<MapGauge[]>(
    () =>
      rows
        .filter((r) => r.lat != null && r.lng != null && r.total != null)
        .map((r) => ({
          id: r.id,
          name: r.name,
          lat: r.lat as number,
          lng: r.lng as number,
          mm: r.total as number,
          mmLabel: fmt(r.total as number),
          color: r.color,
          reporting: r.reporting,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  );
  const noLocationCount = withData.length - mapGauges.length;

  // Over-time chart: farm-average rainfall per day across the window (min 7 days
  // of context even for "today").
  const bars: DayBar[] = useMemo(() => {
    const win = Math.max(7, periodDays(period));
    const daily = devices.map((d) => dailyByDevice[d.id] ?? new Map<string, number>());
    const today = devices.map((d) => {
      const channel = channelByDevice[d.id] ?? gaugeAppName;
      return num(tagAggs[d.id]?.data?.[channel]?.since_9am);
    });
    return farmDailyAverages(daily, today, win);
  }, [devices, dailyByDevice, tagAggs, channelByDevice, gaugeAppName, period]);
  const barMax = useMemo(() => Math.max(...bars.map((b) => b.mm), 0.1), [bars]);
  const periodTotalBars = useMemo(() => bars.reduce((s, b) => s + b.mm, 0), [bars]);
  const peakDay = useMemo(() => Math.max(...bars.map((b) => b.mm), 0), [bars]);

  // Legend cells up to the band above the max gauge value.
  const legend = useMemo(() => {
    const maxV = withData.length ? Math.max(...withData.map((r) => r.total as number)) : 0;
    let hi = BOM.findIndex((s) => s[0] > maxV);
    if (hi < 0) hi = BOM.length - 1;
    const cells = [];
    for (let i = 0; i < hi; i++) cells.push({ color: rgb(BOM[i][1]), from: BOM[i][0] });
    return { cells, top: BOM[hi][0] };
  }, [withData]);

  if (cfgLoading || (deviceIds.length > 0 && tagQuery.isLoading && withData.length === 0)) {
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
            <Eyebrow>Farm rainfall</Eyebrow>
            <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}>{farmName} — rainfall</div>
            <div style={{ fontSize: 12, color: "var(--muted-foreground)", marginTop: 3 }}>
              How much rain has fallen across the property · {periodLabel(period)}
            </div>
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
            eyebrow="Farm average"
            value={stats ? <>{fmt(stats.avg)} <Unit /></> : "—"}
            sub={`across ${withData.length} gauges · ${periodLabel(period)}`}
          />
          <StatTile
            eyebrow="Wettest gauge"
            value={stats ? <>{fmt(stats.wettest.total as number)} <Unit /></> : "—"}
            sub={stats ? <><ColorDot color={stats.wettest.color} />{stats.wettest.name}</> : "—"}
          />
          <StatTile
            eyebrow="Driest gauge"
            value={stats ? <>{fmt(stats.driest.total as number)} <Unit /></> : "—"}
            sub={stats ? <><ColorDot color={stats.driest.color} />{stats.driest.name}</> : "—"}
          />
          <StatTile
            eyebrow="Spread"
            value={stats ? <>{fmt(stats.spread)} <Unit /></> : "—"}
            sub="wettest − driest across farm"
          />
        </div>

        {/* Map */}
        <Card style={{ padding: 0, gap: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <Eyebrow>Rainfall surface</Eyebrow>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Where the rain fell · {periodLabel(period)}</div>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted-foreground)" }}>
              Interpolated from {mapGauges.length} located gauge{mapGauges.length === 1 ? "" : "s"}
            </div>
          </div>
          {mapGauges.length === 0 ? (
            <div style={{ padding: "40px 16px", textAlign: "center", fontSize: 13, color: "var(--muted-foreground)" }}>
              No gauges have a location set, so the map can't be drawn. Set each gauge's location on its device to place it
              here.
            </div>
          ) : (
            <RainfallMap gauges={mapGauges} height={520} />
          )}
          {/* Legend */}
          {legend.cells.length > 0 && (
            <div style={{ padding: "13px 16px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", borderTop: "1px solid var(--border)" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 240 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <Eyebrow>Rainfall · BOM scale</Eyebrow>
                  <span style={{ fontSize: 10, color: "var(--muted-foreground)" }}>mm</span>
                </div>
                <div style={{ display: "flex", height: 10, borderRadius: 3, overflow: "hidden", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.12)" }}>
                  {legend.cells.map((c, i) => (
                    <div key={i} style={{ flex: 1, background: c.color }} />
                  ))}
                </div>
                <div style={{ display: "flex" }}>
                  {legend.cells.map((c, i) => (
                    <div key={i} style={{ flex: 1, fontSize: 10, color: "var(--muted-foreground)" }}>{c.from}</div>
                  ))}
                  <div style={{ fontSize: 10, color: "var(--muted-foreground)", fontWeight: 600 }}>{legend.top}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)", maxWidth: 360, lineHeight: 1.5 }}>
                Colour fades to the satellite away from any gauge, where the estimate is least certain — gauge pins are the
                source of truth.
                {noLocationCount > 0 && ` ${noLocationCount} gauge${noLocationCount === 1 ? "" : "s"} without a location aren't shown on the map.`}
              </div>
            </div>
          )}
        </Card>

        {/* Supporting row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14 }}>
          {/* Per-gauge table */}
          <Card style={{ padding: 0, gap: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px 10px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Rain gauges</div>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{periodLabel(period)}</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: "var(--muted-foreground)", fontSize: 11, textAlign: "left" }}>
                  <th style={{ padding: "6px 16px", fontWeight: 500 }}>Gauge</th>
                  <th style={{ padding: "6px 16px", fontWeight: 500, textAlign: "right" }}>Rain</th>
                  <th style={{ padding: "6px 16px", fontWeight: 500, textAlign: "right" }}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {sortRows(rows).map((g) => (
                  <tr key={g.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <ColorDot color={g.color} muted={g.total == null} />
                        <span style={{ fontWeight: 500 }}>{g.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: "8px 16px", textAlign: "right", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {g.total == null ? <span style={{ color: "var(--muted-foreground)" }}>—</span> : `${fmt(g.total)} mm`}
                    </td>
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
                          {g.lastSeenMs ? dayjs(g.lastSeenMs).fromNow() : "never"}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Over time */}
          <Card style={{ gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>Rainfall over time</div>
              <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>farm average · mm / day</span>
            </div>
            <div style={{ display: "flex", alignItems: "stretch", gap: bars.length > 14 ? 2 : 6 }}>
              {bars.map((b) => (
                <div key={b.key} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 5, minWidth: 0 }}>
                  <div style={{ width: "100%", height: 120, display: "flex", alignItems: "flex-end", justifyContent: "center" }} title={`${b.label}: ${b.mm} mm`}>
                    <div
                      style={{
                        width: "72%",
                        height: `${(b.mm / barMax) * 100}%`,
                        minHeight: 2,
                        background: "linear-gradient(180deg,#5b9bf0,#3b5bd6)",
                        borderRadius: "3px 3px 0 0",
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 9, color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>
                    {bars.length > 14 ? "" : b.label}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted-foreground)", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              Total this period{" "}
              <span style={{ color: "var(--foreground)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {periodTotalBars.toFixed(dec)} mm
              </span>{" "}
              · peak day{" "}
              <span style={{ color: "var(--foreground)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {peakDay.toFixed(dec)} mm
              </span>
            </div>
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
