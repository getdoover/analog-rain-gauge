import { useEffect, useRef, useState } from "react";
import GoogleMap, {
  type Map as GMap,
  type MapsLibrary,
  type onGoogleApiLoadedProps,
} from "google-maps-react-markers";

import type { RadarGrid } from "../lib/radar";
import { createRadarLayer, type RadarLayerHandle } from "./RadarLayer";
import { createRainViewerLayer, type RainViewerLayerHandle } from "./RainViewerLayer";

// Doover's shared Google Maps JS API key (same one the admin site uses).
const GOOGLE_MAPS_API_KEY = "AIzaSyDZ_rSbTPIh_JbUJVjFAOkoCk-OuIrL01U";

export interface MapGauge {
  id: string;
  name: string;
  lat: number;
  lng: number;
  mm: number; // rainfall over the selected time window (mm)
  mmLabel: string;
  color: string; // per-gauge palette colour (matches the timeline)
  reporting: boolean;
}

export interface RadarOverlay {
  /** RainViewer tile URL template for the shown time; when set it replaces the BOM grids. */
  tiles: string | null;
  /** Other RainViewer frames whose tiles to load ahead, so scrubbing is instant. */
  tilePreload: string[];
  local: RadarGrid | null;
  national: RadarGrid | null;
  opacity: number; // 0..1
  /** Zoom at or above which the local radar is shown instead of the national mosaic. */
  localMinZoom: number;
}

interface RainfallMapProps {
  gauges: MapGauge[];
  height?: number | string;
  radar?: RadarOverlay | null;
  /** Reports which radar layer the current zoom selects. */
  onRadarLayerChange?: (layer: "local" | "national") => void;
  /** Drawn over the map (e.g. the time slider). */
  children?: React.ReactNode;
}

// Gauge names only once zoomed in far enough that they don't pile up.
const NAME_MIN_ZOOM = 11;

export default function RainfallMap({ gauges, height = 540, radar, onRadarLayerChange, children }: RainfallMapProps) {
  const mapRef = useRef<GMap | null>(null);
  const mapsRef = useRef<MapsLibrary | null>(null);
  const didFitRef = useRef(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const radarLayerRef = useRef<RadarLayerHandle | null>(null);
  const tileLayerRef = useRef<RainViewerLayerHandle | null>(null);

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
    setZoom(map.getZoom() ?? null);
    map.addListener("zoom_changed", () => setZoom(map.getZoom() ?? null));
    setMapReady(true);
    if (!didFitRef.current && gauges.length > 0) {
      fitToGauges(gauges);
      didFitRef.current = true;
    }
  };

  // Fit to the gauges once they first arrive (data can load after the map).
  useEffect(() => {
    if (!didFitRef.current && mapRef.current && gauges.length > 0) {
      fitToGauges(gauges);
      didFitRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gauges]);

  // Radar: the local site image when zoomed in, the national mosaic zoomed out
  // (and whichever exists when only one does).
  const layer: "local" | "national" =
    radar && zoom != null && zoom >= radar.localMinZoom ? "local" : "national";
  useEffect(() => {
    onRadarLayerChange?.(layer);
  }, [layer, onRadarLayerChange]);
  const tiles = radar?.tiles ?? null;
  const grid = radar && !tiles
    ? layer === "local"
      ? radar.local ?? radar.national
      : radar.national ?? radar.local
    : null;

  useEffect(() => {
    const map = mapRef.current;
    const maps = mapsRef.current as unknown as typeof google.maps | null;
    if (!mapReady || !map || !maps) return;
    radarLayerRef.current ??= createRadarLayer(map as unknown as google.maps.Map, maps);
    radarLayerRef.current.setOpacity(radar?.opacity ?? 0.75);
    radarLayerRef.current.setGrid(grid);
    tileLayerRef.current ??= createRainViewerLayer(map as unknown as google.maps.Map, maps);
    tileLayerRef.current.setOpacity(radar?.opacity ?? 0.75);
    tileLayerRef.current.setTemplate(tiles);
    tileLayerRef.current.setPreload(tiles ? radar?.tilePreload ?? [] : []);
  }, [mapReady, grid, tiles, radar?.tilePreload, radar?.opacity]);

  useEffect(
    () => () => {
      radarLayerRef.current?.remove();
      tileLayerRef.current?.remove();
    },
    [],
  );

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
          <GaugePin key={g.id} lat={g.lat} lng={g.lng} gauge={g} showName={(zoom ?? 0) >= NAME_MIN_ZOOM} />
        ))}
      </GoogleMap>
      {children}
    </div>
  );
}

// `google-maps-react-markers` positions any child carrying `lat`/`lng` props at
// that coordinate, centring the child's box on it; the extra props are ignored
// by the library and used by us. The pin's box is zero-sized so the dot sits
// exactly on the gauge at every zoom, with the labels hung above and below it.
function GaugePin({ gauge, showName }: { lat: number; lng: number; gauge: MapGauge; showName: boolean }) {
  const DOT = 16;
  return (
    <div style={{ position: "relative", width: 0, height: 0, pointerEvents: "none" }} title={gauge.name}>
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: DOT / 2 + 4,
          transform: "translateX(-50%)",
          whiteSpace: "nowrap",
          background: "rgba(11,18,32,.84)",
          color: "#fff",
          borderRadius: 999,
          padding: "2px 9px",
          fontSize: 12,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {gauge.mmLabel} mm
      </div>
      <div
        style={{
          position: "absolute",
          left: -DOT / 2,
          top: -DOT / 2,
          width: DOT,
          height: DOT,
          boxSizing: "border-box",
          borderRadius: 999,
          background: gauge.color,
          border: "2px solid #fff",
          boxShadow: "0 0 0 1px rgba(0,0,0,.45),0 1px 5px rgba(0,0,0,.55)",
          opacity: gauge.reporting ? 1 : 0.55,
        }}
      />
      {showName && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: DOT / 2 + 3,
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            fontSize: 11,
            color: "#fff",
            fontWeight: 600,
            textShadow: "0 1px 2px rgba(0,0,0,.9)",
          }}
        >
          {gauge.name}
        </div>
      )}
    </div>
  );
}
