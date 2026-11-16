// RainViewer tiles drawn onto a map-sized canvas.
//
// Google's ImageMapType can't over-zoom, and RainViewer's free tiles stop at
// zoom 7, so tiles are drawn here instead: at each view the best available
// tile zoom is chosen (512 px tiles, so view zoom − 1, capped at 7) and the
// tiles are scaled into place with smoothing. While the next frame's tiles
// load, the previous frame stays on screen.

import { RAINVIEWER_MAX_ZOOM, RAINVIEWER_TILE_SIZE } from "../lib/rainviewer";

export interface RainViewerLayerHandle {
  setTemplate(template: string | null): void;
  /** Load (not draw) these frames' tiles for the current view. */
  setPreload(templates: string[]): void;
  setOpacity(opacity: number): void;
  remove(): void;
}

const MAX_DPR = 2;
const images = new Map<string, HTMLImageElement>();

function loadTile(url: string, onLoad: () => void): HTMLImageElement {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.addEventListener("load", onLoad, { once: true });
    img.src = url;
    images.set(url, img);
    if (images.size > 400) images.delete(images.keys().next().value!);
  } else if (!img.complete) {
    img.addEventListener("load", onLoad, { once: true });
  }
  return img;
}

// Web Mercator tile edges.
const tileLng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};
const lngToX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

export function createRainViewerLayer(map: google.maps.Map, maps: typeof google.maps): RainViewerLayerHandle {
  class Overlay extends maps.OverlayView {
    canvas = document.createElement("canvas");
    template: string | null = null;
    preload: string[] = [];
    shown: string | null = null; // template currently on screen
    idle: google.maps.MapsEventListener | null = null;
    raf = 0;

    onAdd() {
      const c = this.canvas;
      c.style.position = "absolute";
      c.style.pointerEvents = "none";
      this.getPanes()!.overlayLayer.appendChild(c);
      this.idle = map.addListener("idle", () => this.draw());
    }
    onRemove() {
      this.idle?.remove();
      this.canvas.remove();
    }
    draw() {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.render());
    }

    /** Tiles for `template` covering the view; null if any aren't loaded yet. */
    tiles(template: string, z: number, bounds: google.maps.LatLngBounds, redraw = true) {
      const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
      const n = 2 ** z;
      const x0 = Math.floor(lngToX(sw.lng(), z)), x1 = Math.floor(lngToX(ne.lng(), z));
      const y0 = Math.max(0, Math.floor(latToY(ne.lat(), z))), y1 = Math.min(n - 1, Math.floor(latToY(sw.lat(), z)));
      const out: { img: HTMLImageElement; x: number; y: number }[] = [];
      let ready = true;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const wx = ((x % n) + n) % n;
          const url = template.replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(y));
          const img = loadTile(url, redraw ? () => this.draw() : () => {});
          if (!img.complete || !img.naturalWidth) ready = false;
          out.push({ img, x, y });
        }
      }
      return { out, ready };
    }

    render() {
      const proj = this.getProjection();
      const bounds = map.getBounds();
      const c = this.canvas;
      if (!proj || !bounds || !this.template) {
        c.width = 0;
        this.shown = null;
        return;
      }
      const zoom = map.getZoom() ?? 0;
      // 512 px tiles carry the detail of 256 px tiles one zoom deeper.
      const z = Math.max(0, Math.min(RAINVIEWER_MAX_ZOOM, Math.round(zoom) - (RAINVIEWER_TILE_SIZE === 512 ? 1 : 0)));

      // Keep the old frame up until the new one's tiles are all in.
      let use = this.template;
      let { out, ready } = this.tiles(use, z, bounds);
      if (!ready && this.shown && this.shown !== use) {
        use = this.shown;
        ({ out } = this.tiles(use, z, bounds));
      }

      const div = map.getDiv();
      const ne = bounds.getNorthEast(), sw = bounds.getSouthWest();
      const origin = proj.fromLatLngToDivPixel(new maps.LatLng(ne.lat(), sw.lng()))!;
      const cssW = div.clientWidth, cssH = div.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      c.style.left = `${origin.x}px`;
      c.style.top = `${origin.y}px`;
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.scale(dpr, dpr);
      for (const { img, x, y } of out) {
        if (!img.complete || !img.naturalWidth) continue;
        const nw = proj.fromLatLngToDivPixel(new maps.LatLng(tileLat(y, z), tileLng(x, z)))!;
        const se = proj.fromLatLngToDivPixel(new maps.LatLng(tileLat(y + 1, z), tileLng(x + 1, z)))!;
        ctx.drawImage(img, nw.x - origin.x, nw.y - origin.y, se.x - nw.x, se.y - nw.y);
      }
      this.shown = use;
      // Load the other frames' tiles for this view in the background.
      for (const t of this.preload) if (t !== use) this.tiles(t, z, bounds, false);
    }
  }

  const overlay = new Overlay();
  overlay.setMap(map);
  return {
    setTemplate(template) {
      if (overlay.template === template) return;
      overlay.template = template;
      overlay.draw();
    },
    setPreload(templates) {
      overlay.preload = templates;
    },
    setOpacity(opacity) {
      overlay.canvas.style.opacity = String(opacity);
    },
    remove() {
      overlay.setMap(null);
    },
  };
}
