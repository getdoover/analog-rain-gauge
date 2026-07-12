import { useMemo, useRef } from "react";

import { bomBand, niceMax, rgb, type TimeBin } from "../lib/rainfall";

export interface TimelineSeries {
  id: string;
  name: string;
  binMm: number[]; // mm per bin, aligned to `bins`
}

interface RainfallTimelineProps {
  bins: TimeBin[];
  series: TimelineSeries[];
  /** Inclusive [startIdx, endIdx] of the selected bin window. */
  selection: [number, number];
  onSelectionChange: (sel: [number, number]) => void;
  height?: number;
}

const PLOT_H = 150;

function clampIdx(i: number, n: number): number {
  return i < 0 ? 0 : i > n - 1 ? n - 1 : i;
}

function tickLabel(t: number, axisMax: number): string {
  return axisMax < 10 ? t.toFixed(1) : String(Math.round(t));
}

/**
 * Stacked column chart (one colour band per gauge) with a draggable brush below
 * it for selecting a time window. Either handle drags independently, or grab the
 * middle of the band to slide the whole window. The selection is controlled by
 * the parent (it also drives the map).
 */
export default function RainfallTimeline({
  bins,
  series,
  selection,
  onSelectionChange,
  height = PLOT_H,
}: RainfallTimelineProps) {
  const n = bins.length;
  const [startIdx, endIdx] = selection;

  // Stack total per bin → "nice" y-axis max + 5 descending ticks.
  const binTotals = useMemo(() => {
    const t = new Array(n).fill(0);
    for (const s of series) for (let i = 0; i < n; i++) t[i] += s.binMm[i] ?? 0;
    return t;
  }, [series, n]);
  const axisMax = useMemo(() => niceMax(Math.max(0, ...binTotals)), [binTotals]);
  const yTicks = useMemo(
    () => Array.from({ length: 5 }, (_, i) => axisMax * (1 - i / 4)),
    [axisMax],
  );

  // Thin x-axis labels so they never collide (aim for ~12 visible).
  const labelStep = Math.max(1, Math.ceil(n / 12));

  // --- Brush dragging ---------------------------------------------------
  const plotRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | { mode: "left" | "right" | "move"; startIdx: number; endIdx: number; grabIdx: number }
    | null
  >(null);

  const idxAt = (clientX: number): number => {
    const el = plotRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const frac = (clientX - r.left) / Math.max(1, r.width);
    return clampIdx(Math.floor(frac * n), n);
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const i = idxAt(e.clientX);
    if (d.mode === "left") {
      onSelectionChange([Math.min(i, d.endIdx), d.endIdx]);
    } else if (d.mode === "right") {
      onSelectionChange([d.startIdx, Math.max(i, d.startIdx)]);
    } else {
      const width = d.endIdx - d.startIdx;
      const ns = clampIdx(d.startIdx + (i - d.grabIdx), n - width); // keep width in range
      onSelectionChange([ns, ns + width]);
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
  };

  const beginDrag = (mode: "left" | "right" | "move") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startIdx, endIdx, grabIdx: idxAt(e.clientX) };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  };

  const leftPct = (startIdx / n) * 100;
  const rightPct = ((endIdx + 1) / n) * 100;
  const handleW = 9;

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        {/* Y-axis */}
        <div
          style={{
            height,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-end",
            fontSize: 9,
            color: "var(--muted-foreground)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {yTicks.map((t, i) => (
            <span key={i} style={{ lineHeight: 1 }}>
              {tickLabel(t, axisMax)}
            </span>
          ))}
        </div>

        {/* Plot + brush + labels */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div ref={plotRef} style={{ position: "relative", height, touchAction: "none" }}>
            {/* gridlines */}
            {yTicks.map((t, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: `${(1 - t / axisMax) * 100}%`,
                  borderTop: "1px solid var(--border)",
                  opacity: 0.55,
                }}
              />
            ))}

            {/* stacked columns */}
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-end", gap: n > 24 ? 1 : 3 }}>
              {bins.map((b, bi) => {
                const inSel = bi >= startIdx && bi <= endIdx;
                const total = binTotals[bi];
                return (
                  <div
                    key={b.start}
                    style={{
                      flex: 1,
                      height: "100%",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      minWidth: 0,
                      opacity: inSel ? 1 : 0.32,
                      transition: "opacity .1s",
                    }}
                    title={`${b.full} · ${total.toFixed(1)} mm`}
                  >
                    {series.map((s) => {
                      const mm = s.binMm[bi] ?? 0;
                      if (mm <= 0) return null;
                      return (
                        <div
                          key={s.id}
                          style={{
                            height: `${(mm / axisMax) * 100}%`,
                            background: rgb(bomBand(mm)), // BOM band of this gauge's rain in this bin
                            minHeight: 1,
                            // hairline so adjacent/white (light-rain) segments stay visible
                            boxShadow: "inset 0 0 0 1px rgba(0,0,0,.16)",
                          }}
                          title={`${s.name}: ${mm.toFixed(1)} mm`}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* brush overlay — pointer-transparent except the band + handles, so
                hovering a bar still shows its gauge tooltip */}
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {/* selected band */}
              <div
                onPointerDown={beginDrag("move")}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${leftPct}%`,
                  width: `${rightPct - leftPct}%`,
                  background: "rgba(59,130,246,.10)",
                  borderLeft: "1px solid rgba(59,130,246,.55)",
                  borderRight: "1px solid rgba(59,130,246,.55)",
                  cursor: "grab",
                  pointerEvents: "auto",
                }}
              />
              {/* left handle */}
              <div
                onPointerDown={beginDrag("left")}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `calc(${leftPct}% - ${handleW / 2}px)`,
                  width: handleW,
                  cursor: "ew-resize",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                }}
              >
                <div style={{ width: 3, height: 26, borderRadius: 2, background: "#3b82f6", boxShadow: "0 0 0 1px rgba(255,255,255,.6)" }} />
              </div>
              {/* right handle */}
              <div
                onPointerDown={beginDrag("right")}
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `calc(${rightPct}% - ${handleW / 2}px)`,
                  width: handleW,
                  cursor: "ew-resize",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "auto",
                }}
              >
                <div style={{ width: 3, height: 26, borderRadius: 2, background: "#3b82f6", boxShadow: "0 0 0 1px rgba(255,255,255,.6)" }} />
              </div>
            </div>
          </div>

          {/* x-axis labels */}
          <div style={{ display: "flex", gap: n > 24 ? 1 : 3, marginTop: 5 }}>
            {bins.map((b, bi) => (
              <div
                key={b.start}
                style={{
                  flex: 1,
                  textAlign: "center",
                  fontSize: 9,
                  color: "var(--muted-foreground)",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                  overflow: "hidden",
                }}
              >
                {bi % labelStep === 0 ? b.label : ""}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
