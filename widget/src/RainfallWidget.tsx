import "./styles.css";
import {useState, useMemo, useEffect} from "react";
import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import {useChannelMessages} from "customer_site/hooks";
import {useRemoteParams} from "customer_site/useRemoteParams";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChannelMessage {
  data: {
    type: string;
    mm?: number;
    total_mm?: number;
    date?: string;
    timestamp: number;
  };
  id: string;
  timestamp: number;
}

function normalizeMessage(msg: any): ChannelMessage | null {
  if (!msg?.data) return null;
  for (const type of ["pulse", "daily", "event"] as const) {
    const inner = msg.data[type];
    if (inner && typeof inner === "object") {
      return {
        ...msg,
        data: { type, ...inner },
      };
    }
  }
  // Legacy format
  if (msg.data.type) return msg as ChannelMessage;
  return null;
}

interface ChartBucket {
  label: string;
  mm: number;
  year?: number;
  month?: number;
  day?: number;
}

interface CompareChartBucket {
  label: string;
  [key: string]: string | number;
}

interface UiRemoteComponentRainfall {
  app_key: string;
}

type Tab = "today" | "month" | "year" | "annual";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLocalDate9am(): Date {
  const now = new Date();
  const today9am = new Date(now);
  today9am.setHours(9, 0, 0, 0);

  if (now < today9am) {
    today9am.setDate(today9am.getDate() - 1);
  }
  return today9am;
}

function formatHour(hour: number): string {
  const suffix = hour >= 12 ? "pm" : "am";
  const h = hour % 12 || 12;
  return `${h}${suffix}`;
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const COMPARE_COLORS = [
  "var(--primary)",
  "steelblue",
  "limegreen",
  "maroon",
  "peru",
  "slategray",
  "mediumpurple",
  "lightcoral",
];

// ---------------------------------------------------------------------------
// Bucketing functions
// ---------------------------------------------------------------------------

function bucketTodayByHour(messages: ChannelMessage[]): ChartBucket[] {
  const start9am = getLocalDate9am();
  const now = new Date();

  const buckets: Map<number, number> = new Map();
  const cursor = new Date(start9am);
  while (cursor <= now) {
    buckets.set(cursor.getHours(), 0);
    cursor.setHours(cursor.getHours() + 1);
  }

  const start9amMs = start9am.getTime();
  for (const msg of messages) {
    if (msg.data.type !== "pulse") continue;
    const ts = msg.data.timestamp;
    if (ts < start9amMs) continue;

    const d = new Date(ts);
    const h = d.getHours();
    if (buckets.has(h)) {
      buckets.set(h, (buckets.get(h) || 0) + (msg.data.mm || 0));
    }
  }

  const result: ChartBucket[] = [];
  const iter = new Date(start9am);
  while (iter <= now) {
    const h = iter.getHours();
    result.push({
      label: formatHour(h),
      mm: Math.round((buckets.get(h) || 0) * 100) / 100,
    });
    iter.setHours(iter.getHours() + 1);
  }
  return result;
}

function bucketMonthByDay(
  messages: ChannelMessage[],
  year: number,
  month: number,
): ChartBucket[] {
  const now = new Date();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lastDay = isCurrentMonth ? now.getDate() : daysInMonth;

  const buckets: Map<number, number> = new Map();
  for (let d = 1; d <= daysInMonth; d++) {
    buckets.set(d, 0);
  }

  for (const msg of messages) {
    if (msg.data.type !== "daily" || !msg.data.date) continue;
    const [y, m, d] = msg.data.date.split("-").map(Number);
    if (y === year && m === month + 1) {
      buckets.set(d, (buckets.get(d) || 0) + (msg.data.total_mm || 0));
    }
  }

  if (isCurrentMonth) {
    const start9am = getLocalDate9am();
    const todayDate = start9am.getDate();
    const start9amMs = start9am.getTime();
    for (const msg of messages) {
      if (msg.data.type !== "pulse") continue;
      if (msg.data.timestamp >= start9amMs) {
        buckets.set(todayDate, (buckets.get(todayDate) || 0) + (msg.data.mm || 0));
      }
    }
  }

  const result: ChartBucket[] = [];
  for (let d = 1; d <= lastDay; d++) {
    result.push({
      label: `${pad2(d)}/${pad2(month + 1)}`,
      mm: Math.round((buckets.get(d) || 0) * 100) / 100,
      year,
      month,
      day: d,
    });
  }
  return result;
}

function getYearMonthlyTotals(
  messages: ChannelMessage[],
  year: number,
): Map<number, number> {
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();

  const buckets: Map<number, number> = new Map();
  for (let m = 0; m <= 11; m++) {
    buckets.set(m, 0);
  }

  for (const msg of messages) {
    if (msg.data.type !== "daily" || !msg.data.date) continue;
    const [y, m] = msg.data.date.split("-").map(Number);
    if (y === year) {
      buckets.set(m - 1, (buckets.get(m - 1) || 0) + (msg.data.total_mm || 0));
    }
  }

  if (isCurrentYear) {
    const start9am = getLocalDate9am();
    const start9amMs = start9am.getTime();
    const currentMonth = now.getMonth();
    for (const msg of messages) {
      if (msg.data.type !== "pulse") continue;
      if (msg.data.timestamp >= start9amMs) {
        buckets.set(currentMonth, (buckets.get(currentMonth) || 0) + (msg.data.mm || 0));
      }
    }
  }

  return buckets;
}

function bucketYearByMonth(
  messages: ChannelMessage[],
  year: number,
): ChartBucket[] {
  const now = new Date();
  const isCurrentYear = year === now.getFullYear();
  const lastMonth = isCurrentYear ? now.getMonth() : 11;
  const buckets = getYearMonthlyTotals(messages, year);

  const result: ChartBucket[] = [];
  for (let m = 0; m <= lastMonth; m++) {
    result.push({
      label: MONTH_NAMES[m],
      mm: Math.round((buckets.get(m) || 0) * 100) / 100,
      year,
      month: m,
    });
  }
  return result;
}

function bucketYearCompare(
  messages: ChannelMessage[],
  years: number[],
): {data: CompareChartBucket[]; keys: string[]} {
  const allBuckets = years.map((y) => ({
    key: String(y),
    buckets: getYearMonthlyTotals(messages, y),
  }));

  const result: CompareChartBucket[] = [];
  for (let m = 0; m <= 11; m++) {
    const entry: CompareChartBucket = {label: MONTH_NAMES[m]};
    for (const {key, buckets} of allBuckets) {
      entry[key] = Math.round((buckets.get(m) || 0) * 100) / 100;
    }
    result.push(entry);
  }
  return {data: result, keys: allBuckets.map((b) => b.key)};
}

function bucketMonthCompare(
  messages: ChannelMessage[],
  months: {year: number; month: number}[],
): {data: CompareChartBucket[]; keys: string[]} {
  const maxDays = Math.max(...months.map((m) => new Date(m.year, m.month + 1, 0).getDate()));
  const keys = months.map((m) => `${MONTH_NAMES[m.month]} ${m.year}`);

  const allBuckets = months.map((m) => {
    const data = bucketMonthByDay(messages, m.year, m.month);
    const map = new Map<number, number>();
    for (const d of data) {
      if (d.day != null) map.set(d.day, d.mm);
    }
    return map;
  });

  const result: CompareChartBucket[] = [];
  for (let d = 1; d <= maxDays; d++) {
    const entry: CompareChartBucket = {label: String(d)};
    for (let i = 0; i < keys.length; i++) {
      entry[keys[i]] = allBuckets[i].get(d) || 0;
    }
    result.push(entry);
  }
  return {data: result, keys};
}

function bucketAnnualTotals(
  messages: ChannelMessage[],
  years: number[],
): ChartBucket[] {
  const now = new Date();
  const start9am = getLocalDate9am();
  const start9amMs = start9am.getTime();

  const buckets: Map<number, number> = new Map();
  for (const y of years) {
    buckets.set(y, 0);
  }

  for (const msg of messages) {
    if (msg.data.type !== "daily" || !msg.data.date) continue;
    const y = parseInt(msg.data.date.split("-")[0], 10);
    if (buckets.has(y)) {
      buckets.set(y, (buckets.get(y) || 0) + (msg.data.total_mm || 0));
    }
  }

  // Add today's live pulses to current year
  const currentYear = now.getFullYear();
  if (buckets.has(currentYear)) {
    for (const msg of messages) {
      if (msg.data.type !== "pulse") continue;
      if (msg.data.timestamp >= start9amMs) {
        buckets.set(currentYear, (buckets.get(currentYear) || 0) + (msg.data.mm || 0));
      }
    }
  }

  // Sort ascending by year
  const sorted = [...years].sort((a, b) => a - b);
  return sorted.map((y) => ({
    label: String(y),
    mm: Math.round((buckets.get(y) || 0) * 100) / 100,
    year: y,
  }));
}

// ---------------------------------------------------------------------------
// Derive available months/years from messages
// ---------------------------------------------------------------------------

function getAvailableMonths(messages: ChannelMessage[]): {year: number; month: number}[] {
  const set = new Set<string>();
  const now = new Date();
  set.add(`${now.getFullYear()}-${now.getMonth()}`);

  for (const msg of messages) {
    if (msg.data.type === "daily" && msg.data.date) {
      const [y, m] = msg.data.date.split("-").map(Number);
      set.add(`${y}-${m - 1}`);
    }
  }

  return Array.from(set)
    .map((s) => {
      const [year, month] = s.split("-").map(Number);
      return {year, month};
    })
    .sort((a, b) => b.year - a.year || b.month - a.month);
}

function getAvailableYears(messages: ChannelMessage[]): number[] {
  const set = new Set<number>();
  const now = new Date();
  set.add(now.getFullYear());

  for (const msg of messages) {
    if (msg.data.type === "daily" && msg.data.date) {
      const y = parseInt(msg.data.date.split("-")[0], 10);
      set.add(y);
    }
  }

  return Array.from(set).sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({active, payload, label, tooltipContext}: any) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload;

  let displayLabel = label;
  if (tooltipContext === "year" && entry?.year != null) {
    displayLabel = `${label} ${entry.year}`;
  } else if (tooltipContext === "month" && entry?.year != null && entry?.month != null && entry?.day != null) {
    displayLabel = `${entry.day} ${MONTH_NAMES[entry.month]} ${entry.year}`;
  }

  if (payload.length > 1) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-1.5 text-xs shadow-md">
        <p className="font-medium mb-1">{displayLabel}</p>
        {payload.map((p: any) => (
          <p key={p.dataKey} style={{color: p.fill}} className="flex justify-between gap-3">
            <span>{p.dataKey}</span>
            <span className="font-medium">{p.value} mm</span>
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-background px-3 py-1.5 text-xs shadow-md">
      <p className="font-medium">{displayLabel}</p>
      <p className="text-muted-foreground">{payload[0].value} mm</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period selector (month or year picker)
// ---------------------------------------------------------------------------

function PeriodSelector({
  options,
  selected,
  onSelect,
  format,
}: {
  options: string[];
  selected: string;
  onSelect: (v: string) => void;
  format?: (v: string) => string;
}) {
  const idx = options.indexOf(selected);
  const canPrev = idx < options.length - 1;
  const canNext = idx > 0;

  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => canPrev && onSelect(options[idx + 1])}
        disabled={!canPrev}
        className="px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-30 disabled:cursor-default select-none"
      >
        &larr;
      </button>
      <span className="text-xs font-medium text-foreground min-w-[70px] text-center">
        {format ? format(selected) : selected}
      </span>
      <button
        onClick={() => canNext && onSelect(options[idx - 1])}
        disabled={!canNext}
        className="px-1.5 py-0.5 rounded text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-30 disabled:cursor-default select-none"
      >
        &rarr;
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-select dropdown
// ---------------------------------------------------------------------------

function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  format,
}: {
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  format?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (val: string) => {
    if (selected.includes(val)) {
      onChange(selected.filter((s) => s !== val));
    } else {
      onChange([...selected, val]);
    }
  };

  const label = selected.length === 0
    ? placeholder
    : selected.map((s) => format ? format(s) : s).join(", ");

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs rounded border border-border bg-background px-2 py-1 text-foreground hover:bg-muted/50 min-w-[80px]"
      >
        <span className="truncate max-w-[140px]">{label}</span>
        <span className="text-muted-foreground ml-auto">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 rounded border border-border bg-background shadow-lg py-1 min-w-[120px] max-h-[200px] overflow-y-auto">
            {options.map((opt) => (
              <label
                key={opt}
                className="flex items-center gap-2 px-2 py-1 text-xs text-foreground hover:bg-muted/50 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(opt)}
                  onChange={() => toggle(opt)}
                  className="rounded border-border accent-[var(--primary)]"
                />
                {format ? format(opt) : opt}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner widget
// ---------------------------------------------------------------------------

function RainfallWidgetInner({uiElement}: {uiElement: UiRemoteComponentRainfall}) {
  const {agentId} = useRemoteParams();
  const appKey = uiElement.app_key;
  const [activeTab, setActiveTab] = useState<Tab>("today");

  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(
    `${now.getFullYear()}-${now.getMonth()}`,
  );
  const [selectedYear, setSelectedYear] = useState(String(now.getFullYear()));
  const [compareYears, setCompareYears] = useState<string[]>([]);
  const [compareMonths, setCompareMonths] = useState<string[]>([]);

  const {data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage} =
    useChannelMessages({
      agentId,
      channelName: appKey,
    });

  // Auto-fetch all pages
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const allMessages = useMemo(() => {
    if (!data?.pages) return [];
    const msgs: ChannelMessage[] = [];
    for (const page of data.pages) {
      if (!page) continue;
      for (const msg of page) {
        const normalized = normalizeMessage(msg);
        if (normalized && (normalized.data.type === "pulse" || normalized.data.type === "daily")) {
          msgs.push(normalized);
        }
      }
    }
    return msgs;
  }, [data]);

  const availableMonths = useMemo(() => getAvailableMonths(allMessages), [allMessages]);
  const availableYears = useMemo(() => getAvailableYears(allMessages), [allMessages]);

  const monthOptions = useMemo(
    () => availableMonths.map((m) => `${m.year}-${m.month}`),
    [availableMonths],
  );
  const yearOptions = useMemo(
    () => availableYears.map(String),
    [availableYears],
  );

  const effectiveMonth = monthOptions.includes(selectedMonth) ? selectedMonth : monthOptions[0];
  const effectiveYear = yearOptions.includes(selectedYear) ? selectedYear : yearOptions[0];
  const effectiveCompareYears = compareYears.filter((y) => yearOptions.includes(y) && y !== effectiveYear);
  const effectiveCompareMonths = compareMonths.filter((m) => monthOptions.includes(m) && m !== effectiveMonth);

  // Single-series chart data (today, month, year without compare, annual)
  const chartData = useMemo(() => {
    switch (activeTab) {
      case "today":
        return bucketTodayByHour(allMessages);
      case "month": {
        if (effectiveCompareMonths.length > 0) return [];
        const [y, m] = effectiveMonth.split("-").map(Number);
        return bucketMonthByDay(allMessages, y, m);
      }
      case "year":
        if (effectiveCompareYears.length > 0) return [];
        return bucketYearByMonth(allMessages, parseInt(effectiveYear, 10));
      case "annual":
        return bucketAnnualTotals(allMessages, availableYears);
    }
  }, [allMessages, activeTab, effectiveMonth, effectiveYear, effectiveCompareYears, effectiveCompareMonths, availableYears]);

  // Compare data for year or month tabs
  const compareData = useMemo(() => {
    if (activeTab === "year" && effectiveCompareYears.length > 0) {
      const allYears = [parseInt(effectiveYear, 10), ...effectiveCompareYears.map((y) => parseInt(y, 10))];
      return bucketYearCompare(allMessages, allYears);
    }
    if (activeTab === "month" && effectiveCompareMonths.length > 0) {
      const primary = effectiveMonth.split("-").map(Number);
      const allMonths = [
        {year: primary[0], month: primary[1]},
        ...effectiveCompareMonths.map((m) => {
          const [y, mo] = m.split("-").map(Number);
          return {year: y, month: mo};
        }),
      ];
      return bucketMonthCompare(allMessages, allMonths);
    }
    return null;
  }, [allMessages, activeTab, effectiveYear, effectiveCompareYears, effectiveMonth, effectiveCompareMonths]);

  const total = useMemo(() => {
    if (compareData) {
      return compareData.keys
        .map((k) => {
          const t = Math.round(compareData.data.reduce((s, b) => s + (b[k] as number), 0) * 100) / 100;
          return `${k}: ${t}`;
        })
        .join(" / ") + " mm";
    }
    const t = Math.round(chartData.reduce((sum, b) => sum + b.mm, 0) * 100) / 100;
    return `Total: ${t} mm`;
  }, [chartData, compareData]);

  const formatMonthLabel = (key: string) => {
    const [y, m] = key.split("-").map(Number);
    return `${MONTH_NAMES[m]} ${y}`;
  };

  const handleBarDoubleClick = (entry: ChartBucket) => {
    if (activeTab === "annual" && entry.year != null) {
      setSelectedYear(String(entry.year));
      setActiveTab("year");
    } else if (activeTab === "year" && entry.year != null && entry.month != null) {
      setSelectedMonth(`${entry.year}-${entry.month}`);
      setActiveTab("month");
    } else if (activeTab === "month" && entry.year != null && entry.month != null && entry.day != null) {
      const now = new Date();
      if (entry.year === now.getFullYear() && entry.month === now.getMonth() && entry.day === now.getDate()) {
        setActiveTab("today");
      }
    }
  };

  const stillLoading = isLoading || isFetchingNextPage;

  if (isLoading && !data?.pages?.length) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading rainfall data...
      </div>
    );
  }

  const isComparing = compareData != null;
  const hasData = isComparing
    ? compareData.data.some((b) => Object.values(b).some((v) => typeof v === "number" && v > 0))
    : chartData.some((b) => b.mm > 0);

  return (
    <div className="w-full p-4">
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-2">
        {(["today", "month", "year", "annual"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={
              "px-3 py-1 rounded-md text-xs font-medium select-none " +
              (activeTab === tab
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50")
            }
          >
            {tab === "today" ? "Today" : tab === "month" ? "Daily" : tab === "year" ? "Monthly" : "Annual"}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {stillLoading ? "Loading..." : total}
        </span>
      </div>

      {/* Period sub-selector + compare for month */}
      {activeTab === "month" && monthOptions.length > 0 && (
        <div className="flex items-center justify-center gap-4 mb-2">
          <PeriodSelector
            options={monthOptions}
            selected={effectiveMonth}
            onSelect={setSelectedMonth}
            format={formatMonthLabel}
          />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Compare:</span>
            <MultiSelect
              options={monthOptions.filter((m) => m !== effectiveMonth)}
              selected={compareMonths}
              onChange={setCompareMonths}
              placeholder="None"
              format={formatMonthLabel}
            />
          </div>
        </div>
      )}

      {/* Period selector + compare for year */}
      {activeTab === "year" && yearOptions.length > 0 && (
        <div className="flex items-center justify-center gap-4 mb-2">
          <PeriodSelector
            options={yearOptions}
            selected={effectiveYear}
            onSelect={setSelectedYear}
          />
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Compare:</span>
            <MultiSelect
              options={yearOptions.filter((y) => y !== effectiveYear)}
              selected={compareYears}
              onChange={setCompareYears}
              placeholder="None"
            />
          </div>
        </div>
      )}

      {!hasData ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          No rainfall recorded.
        </div>
      ) : isComparing ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={compareData.data}
            margin={{top: 4, right: 4, left: -10, bottom: 0}}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--border)"
            />
            <XAxis
              dataKey="label"
              tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
              tickLine={false}
              axisLine={{stroke: "var(--border)"}}
            />
            <YAxis
              tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
              tickLine={false}
              axisLine={false}
              unit=" mm"
              allowDecimals={false}
            />
            <Tooltip
              content={<ChartTooltip tooltipContext="compare" />}
              cursor={{fill: "var(--muted)", opacity: 0.3}}
              isAnimationActive={false}
            />
            <Legend
              wrapperStyle={{fontSize: 11}}
              iconType="square"
              iconSize={10}
            />
            {compareData.keys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                fill={COMPARE_COLORS[i % COMPARE_COLORS.length]}
                radius={[4, 4, 0, 0]}
                maxBarSize={30}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={chartData}
            margin={{top: 4, right: 4, left: -10, bottom: 0}}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--border)"
            />
            <XAxis
              dataKey="label"
              tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
              tickLine={false}
              axisLine={{stroke: "var(--border)"}}
              interval={activeTab === "month" ? Math.max(Math.floor(chartData.length / 10), 0) : 0}
            />
            <YAxis
              tick={{fontSize: 11, fill: "var(--muted-foreground)"}}
              tickLine={false}
              axisLine={false}
              unit=" mm"
              allowDecimals={false}
            />
            <Tooltip
              content={<ChartTooltip tooltipContext={activeTab} />}
              cursor={{fill: "var(--muted)", opacity: 0.3}}
              isAnimationActive={false}
            />
            <Bar
              dataKey="mm"
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
              fill="var(--primary)"
              isAnimationActive={false}
              cursor={activeTab !== "today" ? "pointer" : undefined}
              onDoubleClick={(_data: any, index: number) => {
                if (chartData[index]) handleBarDoubleClick(chartData[index]);
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

const RainfallWidget = (props: any) => {
  return (
    <RemoteComponentWrapper>
      <RainfallWidgetInner {...props} />
    </RemoteComponentWrapper>
  );
};

export default RainfallWidget;
