import { useEffect, useRef } from "react";
import GoogleMap, {
  type Map as GMap,
  type MapsLibrary,
  type onGoogleApiLoadedProps,
} from "google-maps-react-markers";

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

interface RainfallMapProps {
  gauges: MapGauge[];
  height?: number | string;
}

export default function RainfallMap({ gauges, height = 540 }: RainfallMapProps) {
  const mapRef = useRef<GMap | null>(null);
  const mapsRef = useRef<MapsLibrary | null>(null);
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
