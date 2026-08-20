// ---------------------------------------------------------------------------
// Rainfall maths shared by the dashboard: a per-gauge colour palette, the
// time-bucketing used by the over-time timeline, and the pulse → per-bin
// aggregation that drives both the timeline and the map. Each gauge reports
// individual `pulse` events ({ mm, timestamp }); everything here works from
// those raw pulses so any time window can be summed exactly.
// ---------------------------------------------------------------------------

export type Period = "today" | "7d" | "30d";

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function periodDays(period: Period): number {
  return period === "today" ? 1 : period === "7d" ? 7 : 30;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ---------------------------------------------------------------------------
// BOM rainfall-totals colour scale
// ---------------------------------------------------------------------------
// (mm threshold → rgb): white, pale blue, blue, green, lime, yellow, orange,
// red, dark red, purple. Discrete bands by design — the BOM publishes rainfall
// totals in exactly these steps, so this is the scale people already know. Used
// for the map pins, the per-gauge table and the legend (amount of rain).
export const BOM: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [1, [201, 231, 246]],
  [5, [123, 196, 235]],
  [10, [58, 140, 212]],
  [25, [52, 174, 76]],
  [50, [176, 216, 75]],
  [100, [245, 213, 58]],
  [150, [243, 160, 52]],
  [200, [233, 86, 52]],
  [300, [191, 31, 38]],
  [400, [140, 56, 156]],
];

/** Discrete BOM band a value falls in — for pins, legend and the table dots. */
export function bomBand(mm: number): [number, number, number] {
  for (let i = BOM.length - 1; i >= 0; i--) if (mm >= BOM[i][0]) return BOM[i][1];
  return BOM[0][1];
}

export function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ---------------------------------------------------------------------------
// Time bins
// ---------------------------------------------------------------------------
/** A contiguous time bucket on the timeline's x-axis. `start`/`end` are epoch
 *  ms (half-open: [start, end)); `label` is the compact axis tick, `full` is a
 *  longer label for tooltips. */
export interface TimeBin {
  start: number;
  end: number;
  label: string;
  full: string;
}

/**
 * Build the timeline's buckets for a period, ending at `now`, aligned to
 * natural local boundaries so the labels read cleanly:
 *  - today → 24 hourly bins
 *  - 7d    → 28 six-hourly bins (aligned to 00/06/12/18)
 *  - 30d   → 30 daily bins (aligned to local midnight)
 */
export function timeBins(period: Period, now: Date = new Date()): TimeBin[] {
  if (period === "30d") {
    const base = new Date(now);
    base.setHours(0, 0, 0, 0); // local midnight, start of today
    const bins: TimeBin[] = [];
    for (let i = 29; i >= 0; i--) {
      const s = new Date(base);
      s.setDate(s.getDate() - i);
      const e = new Date(s);
      e.setDate(e.getDate() + 1); // setDate respects DST
      const d = `${pad2(s.getDate())}/${pad2(s.getMonth() + 1)}`;
      bins.push({ start: s.getTime(), end: e.getTime(), label: d, full: d });
    }
    return bins;
  }

  if (period === "7d") {
    const base = new Date(now);
    base.setMinutes(0, 0, 0);
    base.setHours(base.getHours() - (base.getHours() % 6)); // start of current 6h block
    const bins: TimeBin[] = [];
    for (let i = 27; i >= 0; i--) {
      const s = new Date(base.getTime() - i * 6 * HOUR_MS);
      const h = s.getHours();
      const date = `${pad2(s.getDate())}/${pad2(s.getMonth() + 1)}`;
      bins.push({
        start: s.getTime(),
        end: s.getTime() + 6 * HOUR_MS,
        label: h === 0 ? date : `${pad2(h)}:00`,
        full: `${date} ${pad2(h)}:00`,
      });
    }
    return bins;
  }

  // today → hourly
  const base = new Date(now);
  base.setMinutes(0, 0, 0); // start of current hour
  const bins: TimeBin[] = [];
  for (let i = 23; i >= 0; i--) {
    const s = new Date(base.getTime() - i * HOUR_MS);
    const date = `${pad2(s.getDate())}/${pad2(s.getMonth() + 1)}`;
    bins.push({
      start: s.getTime(),
      end: s.getTime() + HOUR_MS,
      label: `${pad2(s.getHours())}:00`,
      full: `${date} ${pad2(s.getHours())}:00`,
    });
  }
  return bins;
}

// ---------------------------------------------------------------------------
// Pulse bucketing
// ---------------------------------------------------------------------------
/** One rain-gauge pulse: `mm` of rain at epoch-ms `ts`. */
export interface PulseSample {
  ts: number;
  mm: number;
}

/**
 * Sum a gauge's pulses into the supplied (contiguous, ascending) bins,
 * returning mm per bin. Pulses outside the bins' span are ignored.
 */
export function bucketPulses(samples: PulseSample[], bins: TimeBin[]): number[] {
  const out = new Array(bins.length).fill(0);
  if (bins.length === 0) return out;
  const first = bins[0].start;
  const last = bins[bins.length - 1].end;
  for (const s of samples) {
    if (s.ts < first || s.ts >= last) continue;
    // largest i with bins[i].start <= s.ts (bins are contiguous)
    let lo = 0;
    let hi = bins.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bins[mid].start <= s.ts) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (s.ts < bins[idx].end) out[idx] += s.mm;
  }
  return out;
}

/** Sum a per-bin series over an inclusive bin-index window. */
export function sumWindow(binMm: number[], startIdx: number, endIdx: number): number {
  let t = 0;
  for (let i = Math.max(0, startIdx); i <= Math.min(binMm.length - 1, endIdx); i++) {
    t += binMm[i];
  }
  return t;
}

/** Round a value up to a "nice" axis maximum (1/2/5 × 10ⁿ), min 1. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(1, nice * pow);
}
