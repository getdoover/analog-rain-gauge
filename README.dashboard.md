# Rainfall Dashboard

A farm-level dashboard that aggregates every **Analog Rain Gauge** device it has
been granted access to into a single view:

- **Stat tiles** — farm average, wettest gauge, driest gauge and the spread
  across the property for the selected period.
- **Rainfall heatmap** — each gauge is placed on a Google Maps satellite
  basemap by its device location, with the rainfall surface between gauges
  estimated by inverse-distance weighting (the fill fades back to the imagery
  away from any gauge, where the estimate is least supported by data — the gauge
  readings are the source of truth).
- **Per-gauge table** — rain total, last-seen and reporting status per gauge.
- **Rainfall over time** — farm-average daily rainfall across the window.
- **BOM radar** — rain radar over the map, played back across the selected
  window: the local radar site when zoomed in, BOM's national mosaic when
  zoomed out.

Periods: **Today** (live, from each gauge's since-9am tag) · **7 days** ·
**30 days** (from each gauge's daily rainfall totals).

## How it works

The dashboard is a lightweight processor that does no per-device work — it
hosts the `RainfallDashboardWidget` remote component, keeps its own agent
online, and records BOM radar images. All rainfall aggregation runs client-side
in the widget.

Grant the dashboard its gauges by setting **Apps Installed** to the Analog Rain
Gauge app in the dashboard's config. The platform then populates a `DEVICE_MAP`
in the dashboard agent's deployment config (carrying each gauge's location and
its data-channel name), which the widget reads. Gauges need a **location** set
on the device to appear on the map; gauges without one still appear in the table
and the totals.

## BOM radar

Every 10 minutes (**Schedule**, advanced) the processor downloads any new radar
images from BOM's FTP feed (`/anon/gen/radar`) and stores each one as a message
on the dashboard's `bom_radar` channel, with the PNG attached. BOM keeps only
about two hours of images; the dashboard keeps them for **Keep Images (days)**
(7 by default; each image is written with that as its TTL, so the platform expires it), so radar can be played back over the 7-day view once it has run
that long. Images are 3–7 KB each, about 430 a day.

| Setting | Description | Default |
|---------|-------------|---------|
| **Show Radar** | Record radar and show it on the map | On |
| **Radar Site** | BOM radar ID (e.g. `53` for Moree). Blank picks the radar nearest the gauges that publishes the chosen range | Blank |
| **Radar Range** | Radius of the local image: 512, 256, 128 or 64 km (not every radar has 64 km) | 128 km |
| **National Mosaic** | Also record `IDR00004`, shown when zoomed out | On |
| **FTP Host / Username / Password** | BOM's anonymous feed by default; set for a Registered User feed | `ftp.bom.gov.au`, anonymous |

The widget reprojects each image onto the map in the browser. Site images are
gnomonic, placed from BOM's corner coordinates
(`radar_transparencies/coordinates/IDRnnnX.map`). The national mosaic has no
published placement: it is Lambert conformal conic (18°S / 40°S, 134°E), with
its scale and origin fitted against the site images. It lines up to within a
pixel or two (about 8–17 km) along the east coast, and is about 25 km out in
south-west WA. The mosaic is only shown zoomed out, where that is under its own
8.5 km pixel size.

The anonymous FTP feed is published for personal use under BOM's copyright
notice; showing it to customers needs BOM's Registered User service, which the
FTP settings above support.
