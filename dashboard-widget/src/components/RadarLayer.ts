// Radar drawn at screen resolution.
//
// A google.maps.OverlayView holding one canvas the size of the map. Whenever
// the view settles (zoom, pan, resize) or the frame changes, every canvas
// pixel is turned back into lat/lng and the radar grid is sampled there, so
// the rain is as smooth at street level as zoomed out to the whole country.

import { RADAR_RGBA, invMercY, mercY, sampleGrid, type RadarGrid } from "../lib/radar";

export interface RadarLayerHandle {
  /** Radars to composite (strongest wins), and the mosaic for where none covers. */
  setGrids(sites: RadarGrid[], national: RadarGrid | null): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

// Draw at most this many device pixels per CSS pixel (sharp but bounded cost).
const MAX_DPR = 2;

export function createRadarLayer(map: google.maps.Map, maps: typeof google.maps): RadarLayerHandle {
  class RadarOverlay extends maps.OverlayView {
    canvas = document.createElement("canvas");
    sites: RadarGrid[] = [];
    national: RadarGrid | null = null;
    idleListener: google.maps.MapsEventListener | null = null;
    frame = 0;

    onAdd() {
      const c = this.canvas;
      c.style.position = "absolute";
      c.style.pointerEvents = "none";
      this.getPanes()!.overlayLayer.appendChild(c);
      // draw() runs on zoom; panning only moves the pane, so redraw for the
      // newly exposed area once the map stops.
      this.idleListener = map.addListener("idle", () => this.draw());
    }

    onRemove() {
      this.idleListener?.remove();
      this.canvas.remove();
    }

    draw() {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.render());
    }

    render() {
      const proj = this.getProjection();
      const bounds = map.getBounds();
      const div = map.getDiv();
      const c = this.canvas;
      if (!proj || !bounds || (!this.sites.length && !this.national)) {
        c.width = 0;
        return;
      }
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      // Canvas covers the visible map, positioned in the pane's coordinates.
      const tl = proj.fromLatLngToDivPixel(new maps.LatLng(ne.lat(), sw.lng()))!;
      const cssW = div.clientWidth, cssH = div.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const W = Math.max(1, Math.round(cssW * dpr));
      const H = Math.max(1, Math.round(cssH * dpr));
      c.style.left = `${tl.x}px`;
      c.style.top = `${tl.y}px`;
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      c.width = W;
      c.height = H;

      const ctx = c.getContext("2d")!;
      const img = ctx.createImageData(W, H);
      const od = img.data;
      let west = sw.lng();
      let east = ne.lng();
      if (east < west) east += 360; // view spans the antimeridian
      const yTop = mercY(ne.lat()), yBottom = mercY(sw.lat());
      const lons = new Float64Array(W);
      for (let i = 0; i < W; i++) {
        let lon = west + ((i + 0.5) / W) * (east - west);
        if (lon > 180) lon -= 360;
        lons[i] = lon;
      }
      const sites = this.sites, national = this.national, n = sites.length;
      for (let j = 0; j < H; j++) {
        const lat = invMercY(yTop + ((j + 0.5) / H) * (yBottom - yTop));
        for (let i = 0; i < W; i++) {
          // Strongest reading among the radars covering this point; the
          // mosaic only where none of them does.
          let v = -1;
          for (let s = 0; s < n; s++) {
            const sv = sampleGrid(sites[s], lons[i], lat);
            if (sv > v) v = sv;
          }
          if (v < 0 && national) v = sampleGrid(national, lons[i], lat);
          if (v <= 0) continue;
          const k = Math.min(255, Math.round((v / 15) * 255)) * 4;
          const a = RADAR_RGBA[k + 3];
          if (a === 0) continue;
          const oi = (j * W + i) * 4;
          od[oi] = RADAR_RGBA[k];
          od[oi + 1] = RADAR_RGBA[k + 1];
          od[oi + 2] = RADAR_RGBA[k + 2];
          od[oi + 3] = a;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  }

  const overlay = new RadarOverlay();
  overlay.setMap(map);
  return {
    setGrids(sites, national) {
      if (overlay.sites === sites && overlay.national === national) return;
      overlay.sites = sites;
      overlay.national = national;
      overlay.draw();
    },
    setOpacity(opacity) {
      overlay.canvas.style.opacity = String(opacity);
    },
    remove() {
      overlay.setMap(null);
    },
  };
}
