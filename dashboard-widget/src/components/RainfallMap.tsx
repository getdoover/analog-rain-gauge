import { useEffect, useRef } from "react";
import GoogleMap, {
  type Map as GMap,
  type MapsLibrary,
  type onGoogleApiLoadedProps,
} from "google-maps-react-markers";

import {
  bomSmooth,
  clamp,
  confidence,
  idw,
  type HeatPoint,
} from "../lib/rainfall";

// Doover's shared Google Maps JS API key (same one the admin site uses).
const GOOGLE_MAPS_API_KEY = "AIzaSyDZ_rSbTPIh_JbUJVjFAOkoCk-OuIrL01U";

export interface MapGauge {
  id: string;
  name: string;
  lat: number;
  lng: number;
  mm: number; // period total (mm)
  mmLabel: string;
  color: string; // pin colour (BOM band)
  reporting: boolean;
}

// Heat-render tuning. We render the IDW field into a canvas anchored to the
// gauges' (padded) bounding box, so it pans with the map for free and only has
// to be repainted on zoom or when the data changes.
const MAX_CANVAS_PX = 900; // cap the heavy per-pixel loop's resolution
const HEAT_STEP = 9; // px between samples (blur smooths the gaps)
const HEAT_INTENSITY = 0.62;
const NEAR_PX = 22; // full confidence within this many px of a gauge
const PAD_FRAC = 0.45; // extend the heat this fraction of the gauge span beyond them

/**
 * A google.maps.OverlayView that paints the inverse-distance-weighted rainfall
 * surface across the gauges, fading to transparent (back to the satellite)
 * away from any gauge. Created lazily once the Maps API is available.
 */
function makeHeatOverlay(maps: MapsLibrary) {
  class HeatOverlay extends maps.OverlayView {
    private canvas: HTMLCanvasElement | null = null;
    private gauges: MapGauge[] = [];
    private dataVersion = 0;
    private lastPaintKey = "";

    setData(gauges: MapGauge[]) {
      this.gauges = gauges;
      this.dataVersion++;
      this.lastPaintKey = ""; // force a repaint
      if (this.getProjection()) this.draw();
    }

    onAdd() {
      const canvas = document.createElement("canvas");
      canvas.style.position = "absolute";
      canvas.style.pointerEvents = "none";
      this.canvas = canvas;
      const panes = this.getPanes();
      panes?.overlayLayer.appendChild(canvas);
    }

    onRemove() {
      this.canvas?.parentNode?.removeChild(this.canvas);
      this.canvas = null;
    }

    draw() {
      const projection = this.getProjection();
      const canvas = this.canvas;
      if (!projection || !canvas || this.gauges.length === 0) {
        if (canvas) canvas.style.display = "none";
        return;
      }
      canvas.style.display = "block";

      // Padded geographic bounding box of the gauges → div-pixel rectangle.
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLng = Infinity;
      let maxLng = -Infinity;
      for (const g of this.gauges) {
        minLat = Math.min(minLat, g.lat);
        maxLat = Math.max(maxLat, g.lat);
        minLng = Math.min(minLng, g.lng);
        maxLng = Math.max(maxLng, g.lng);
      }
      const latSpan = maxLat - minLat || 0.01;
      const lngSpan = maxLng - minLng || 0.01;
      const sw = new maps.LatLng(minLat - latSpan * PAD_FRAC, minLng - lngSpan * PAD_FRAC);
      const ne = new maps.LatLng(maxLat + latSpan * PAD_FRAC, maxLng + lngSpan * PAD_FRAC);
      const swPx = projection.fromLatLngToDivPixel(sw);
      const nePx = projection.fromLatLngToDivPixel(ne);
      if (!swPx || !nePx) return;

      const left = swPx.x;
      const top = nePx.y;
      const cssW = Math.max(1, nePx.x - swPx.x);
      const cssH = Math.max(1, swPx.y - nePx.y);

      // Position the canvas in div-pixel space — stable across pans, so we don't
      // repaint when the user just drags the map.
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      // Internal resolution capped so the per-pixel IDW loop stays cheap.
      const scale = Math.min(1, MAX_CANVAS_PX / Math.max(cssW, cssH));
      const w = Math.max(1, Math.round(cssW * scale));
      const h = Math.max(1, Math.round(cssH * scale));

      const paintKey = `${w}x${h}|v${this.dataVersion}`;
      if (paintKey === this.lastPaintKey) return; // geometry unchanged → keep pixels
      this.lastPaintKey = paintKey;

      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      // Project gauges into canvas-internal coordinates.
      const pts: HeatPoint[] = [];
      for (const g of this.gauges) {
        const p = projection.fromLatLngToDivPixel(new maps.LatLng(g.lat, g.lng));
        if (!p) continue;
        pts.push({ x: (p.x - left) * scale, y: (p.y - top) * scale, v: g.mm });
      }
      if (pts.length === 0) return;

      const near = NEAR_PX * scale;
      const far = clamp(Math.min(w, h) * 0.5, near + 1, 600);

      ctx.save();
      ctx.globalAlpha = HEAT_INTENSITY;
      ctx.filter = `blur(${HEAT_STEP * 1.6}px)`;
      const step = HEAT_STEP;
      for (let py = -2 * step; py < h + 2 * step; py += step) {
        for (let px = -2 * step; px < w + 2 * step; px += step) {
          const c = bomSmooth(idw(px, py, pts));
          const a = confidence(px, py, pts, near, far).toFixed(3);
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
          ctx.fillRect(px, py, step + 1, step + 1);
        }
      }
      ctx.restore();
    }
  }
  return new HeatOverlay();
}

interface RainfallMapProps {
  gauges: MapGauge[];
  height?: number | string;
}

export default function RainfallMap({ gauges, height = 540 }: RainfallMapProps) {
  const mapRef = useRef<GMap | null>(null);
  const mapsRef = useRef<MapsLibrary | null>(null);
  const overlayRef = useRef<{ setData: (g: MapGauge[]) => void } | null>(null);
  const didFitRef = useRef(false);

  const fitToGauges = (gs: MapGauge[]) => {
    const map = mapRef.current;
    const maps = mapsRef.current;
    if (!map || !maps || gs.length === 0) return;
    if (gs.length === 1) {
      map.setCenter({ lat: gs[0].lat, lng: gs[0].lng });
      map.setZoom(15);
      return;
    }
    const bounds = new maps.LatLngBounds();
    for (const g of gs) bounds.extend(new maps.LatLng(g.lat, g.lng));
    map.fitBounds(bounds, 64);
  };

  const onGoogleApiLoaded = ({ map, maps }: onGoogleApiLoadedProps) => {
    mapRef.current = map;
    mapsRef.current = maps as unknown as MapsLibrary;
    const overlay = makeHeatOverlay(maps as unknown as MapsLibrary);
    overlay.setMap(map);
    overlayRef.current = overlay as unknown as { setData: (g: MapGauge[]) => void };
    overlay.setData(gauges);
    if (!didFitRef.current && gauges.length > 0) {
      fitToGauges(gauges);
      didFitRef.current = true;
    }
  };

  // Push fresh data into the overlay when the period / values change.
  useEffect(() => {
    overlayRef.current?.setData(gauges);
    if (!didFitRef.current && mapRef.current && gauges.length > 0) {
      fitToGauges(gauges);
      didFitRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gauges]);

  const mapOptions = {
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
    rotateControl: false,
    scaleControl: false,
    zoomControl: true,
    maxZoom: 20,
    minZoom: 3,
    mapTypeId: "hybrid", // satellite imagery + place labels
    gestureHandling: "cooperative",
    backgroundColor: "#5e6b46",
  };

  return (
    <div style={{ height, width: "100%", position: "relative" }}>
      <GoogleMap
        apiKey={GOOGLE_MAPS_API_KEY}
        defaultCenter={{ lat: -27.344616, lng: 149.437849 }}
        defaultZoom={5}
        options={mapOptions}
        onGoogleApiLoaded={onGoogleApiLoaded}
      >
        {gauges.map((g) => (
          <GaugePin key={g.id} lat={g.lat} lng={g.lng} gauge={g} />
        ))}
      </GoogleMap>
    </div>
  );
}

// `google-maps-react-markers` positions any child carrying `lat`/`lng` props at
// that coordinate; the extra props are ignored by the library and used by us.
function GaugePin({ gauge }: { lat: number; lng: number; gauge: MapGauge }) {
  return (
    <div
      style={{
        transform: "translate(-50%, -50%)",
        pointerEvents: "none",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        whiteSpace: "nowrap",
      }}
      title={gauge.name}
    >
      <div
        style={{
          marginBottom: 4,
          background: "rgba(11,18,32,.84)",
          color: "#fff",
          borderRadius: 999,
          padding: "2px 9px",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {gauge.mmLabel} mm
      </div>
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: 999,
          background: gauge.color,
          border: "2px solid #fff",
          boxShadow: "0 0 0 1px rgba(0,0,0,.45),0 1px 5px rgba(0,0,0,.55)",
          opacity: gauge.reporting ? 1 : 0.55,
        }}
      />
      <div
        style={{
          marginTop: 3,
          fontSize: 11,
          color: "#fff",
          fontWeight: 600,
          textShadow: "0 1px 2px rgba(0,0,0,.9)",
        }}
      >
        {gauge.name}
      </div>
    </div>
  );
}
