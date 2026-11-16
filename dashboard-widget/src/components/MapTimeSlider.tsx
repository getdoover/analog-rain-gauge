import dayjs from "dayjs";

interface MapTimeSliderProps {
  start: number; // epoch ms
  end: number;
  value: number;
  step: number;
  onChange: (t: number) => void;
  /** Small caption, e.g. the radar frame's time. */
  note: string | null;
  /** Data credit shown after the note, linked, with a hover tooltip. */
  source?: { label: string; href: string; title: string } | null;
}

/** Time scrubber drawn over the bottom of the map. */
export default function MapTimeSlider({ start, end, value, step, onChange, note, source }: MapTimeSliderProps) {
  const steps = Math.max(1, Math.round((end - start) / step));
  const idx = Math.round((value - start) / step);
  const atEnd = idx >= steps;
  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        right: 64, // clear of the zoom buttons
        bottom: 22, // clear of the Google attribution
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 12px",
        borderRadius: 10,
        background: "rgba(11,18,32,.78)",
        color: "#fff",
        boxShadow: "0 1px 6px rgba(0,0,0,.35)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 128, lineHeight: 1.25 }}>
        <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
          {atEnd && end >= Date.now() - step ? "Now" : dayjs(value).format("ddd D MMM h:mm a")}
        </span>
        {(note || source) && (
          <span style={{ fontSize: 10, opacity: 0.75, whiteSpace: "nowrap" }}>
            {note}
            {note && source && " · "}
            {source && (
              <a
                href={source.href}
                target="_blank"
                rel="noopener noreferrer"
                title={source.title}
                style={{ color: "inherit", textDecoration: "underline dotted", textUnderlineOffset: 2 }}
              >
                {source.label}
              </a>
            )}
          </span>
        )}
      </div>
      <input
        type="range"
        min={0}
        max={steps}
        value={Math.min(Math.max(idx, 0), steps)}
        onChange={(e) => onChange(start + Number(e.target.value) * step)}
        aria-label="Map time"
        style={{ flex: 1, minWidth: 80, accentColor: "#fff", cursor: "pointer" }}
      />
    </div>
  );
}
