import dayjs from "dayjs";
import { Pause, Play, Radar } from "lucide-react";

// BOM radar reflectivity colours, light → heavy (the palette in the images).
const RADAR_COLOURS = [
  "#f5f5ff", "#b4b4ff", "#7878ff", "#1414ff", "#00d8c3", "#009690", "#006666",
  "#ffff00", "#ffc800", "#ff9600", "#ff6400", "#ff0000", "#c80000", "#780000", "#280000",
];

interface RadarBarProps {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  playing: boolean;
  onPlayingChange: (v: boolean) => void;
  frameCount: number;
  index: number; // into the frames in the window
  onIndexChange: (i: number) => void;
  time: number | null; // shown frame's radar time
  sourceLabel: string; // e.g. "Moree 128 km" / "National mosaic"
  opacity: number;
  onOpacityChange: (v: number) => void;
  loading: boolean;
}

export default function RadarBar(p: RadarBarProps) {
  const muted = "var(--muted-foreground)";
  const noFrames = p.frameCount === 0;
  return (
    <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
          <input type="checkbox" checked={p.enabled} onChange={(e) => p.onEnabledChange(e.target.checked)} />
          <Radar size={14} /> BOM radar
        </label>
        {p.enabled && (
          <>
            <button
              onClick={() => p.onPlayingChange(!p.playing)}
              disabled={p.frameCount < 2}
              title={p.playing ? "Pause" : "Play the radar through the selected window"}
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border)",
                background: "var(--secondary)", color: "var(--foreground)",
                cursor: p.frameCount < 2 ? "default" : "pointer", opacity: p.frameCount < 2 ? 0.5 : 1,
              }}
            >
              {p.playing ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, p.frameCount - 1)}
              value={Math.min(p.index, Math.max(0, p.frameCount - 1))}
              disabled={noFrames}
              onChange={(e) => {
                p.onPlayingChange(false);
                p.onIndexChange(Number(e.target.value));
              }}
              style={{ flex: "1 1 160px", minWidth: 120 }}
              aria-label="Radar time"
            />
            <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", minWidth: 110 }}>
              {noFrames ? (
                <span style={{ color: muted }}>No radar images in this window</span>
              ) : p.time != null ? (
                dayjs(p.time).format("ddd D MMM h:mm a")
              ) : (
                "—"
              )}
            </span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: muted }}>
              Opacity
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.05}
                value={p.opacity}
                onChange={(e) => p.onOpacityChange(Number(e.target.value))}
                style={{ width: 70 }}
                aria-label="Radar opacity"
              />
            </label>
          </>
        )}
      </div>
      {p.enabled && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, color: muted, flexWrap: "wrap" }}>
          <span>Light</span>
          <div style={{ display: "flex", height: 8, width: 150, borderRadius: 2, overflow: "hidden", boxShadow: "inset 0 0 0 1px rgba(0,0,0,.12)" }}>
            {RADAR_COLOURS.map((c) => (
              <div key={c} style={{ flex: 1, background: c }} />
            ))}
          </div>
          <span>Heavy</span>
          <span style={{ marginLeft: "auto" }}>
            {p.loading ? "Loading radar… · " : ""}
            {p.sourceLabel} · Source: Bureau of Meteorology
          </span>
        </div>
      )}
    </div>
  );
}
