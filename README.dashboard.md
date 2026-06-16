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

Periods: **Today** (live, from each gauge's since-9am tag) · **7 days** ·
**30 days** (from each gauge's daily rainfall totals).

## How it works

The dashboard is a lightweight processor that does no per-device work — it only
hosts the `RainfallDashboardWidget` remote component and keeps its own agent
online. All aggregation runs client-side in the widget.

Grant the dashboard its gauges by setting **Apps Installed** to the Analog Rain
Gauge app in the dashboard's config. The platform then populates a `DEVICE_MAP`
in the dashboard agent's deployment config (carrying each gauge's location and
its data-channel name), which the widget reads. Gauges need a **location** set
on the device to appear on the map; gauges without one still appear in the table
and the totals.
