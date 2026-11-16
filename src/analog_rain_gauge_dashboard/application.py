import asyncio
import logging
from datetime import datetime, timedelta, timezone

from pydoover.models.data.connection import ConnectionDisplay
from pydoover.processor import Application
from pydoover.models import (
    ConnectionStatus,
    ConnectionDetermination,
    DeploymentEvent,
    ConnectionConfig,
    ConnectionType,
    File,
    ManualInvokeEvent,
    ScheduleEvent,
)

from . import radar
from .app_config import AnalogRainGaugeDashboardConfig
from .app_ui import AnalogRainGaugeDashboardUI

log = logging.getLogger(__name__)

RADAR_CHANNEL = "bom_radar"


class AnalogRainGaugeDashboardApp(Application):
    """Farm dashboard for devices running Analog Rain Gauge.

    The aggregation — farm average / wettest / driest, the per-gauge table, the
    rainfall-over-time chart and the rainfall map — runs client side in the
    ``RainfallDashboardWidget`` remote component, which reads each gauge's
    pulses and `tag_values` directly.

    The processor hosts that widget (via the static UI schema), keeps the
    dashboard's own agent looking online, and on a schedule copies new BOM radar
    images into the ``bom_radar`` channel so the widget can draw them over the
    map:

    - each 5-minute slot is one message (``{"radar": {slot, frames: [...]}}``)
      with every listed radar's PNG for that slot attached (plus the national
      mosaic), timestamped at the slot start;
    - the aggregate holds each radar's georeference, plus the newest stored
      time per product so a run only fetches what's new;
    - each message is written with a TTL of the configured retention, so the
      platform expires old images itself.
    """

    config_cls = AnalogRainGaugeDashboardConfig
    ui_cls = AnalogRainGaugeDashboardUI

    async def on_deployment(self, event: DeploymentEvent):
        """Ping the connection on (re)deployment so the dashboard agent stays online."""
        await self.api.ping_connection_at(
            datetime.now(timezone.utc),
            ConnectionStatus.continuous_online_no_ping,
            ConnectionDetermination.online,
            user_agent="analog-rain-gauge;rainfall-dashboard",
        )
        await self.api.update_connection_config(
            ConnectionConfig(ConnectionType.periodic, display=ConnectionDisplay.never)
        )
        log.info(f"Pinged connection for dashboard agent {self.agent_id}")
        await self.refresh_radar()

    async def on_schedule(self, event: ScheduleEvent):
        await self.refresh_radar()

    async def on_manual_invoke(self, event: ManualInvokeEvent):
        await self.refresh_radar()

    # -- radar ---------------------------------------------------------------

    def gauge_points(self) -> list[tuple[float, float]]:
        """(lat, lon) of every located gauge in DEVICE_MAP, minus ignored groups."""
        device_map = (self.received_deployment_config or {}).get("DEVICE_MAP") or {}
        ignored = {str(g.value) for g in (self.config.ignore_groups.value or [])}
        points = []
        for entry in device_map.values():
            if not isinstance(entry, dict):
                continue
            group_id = (entry.get("group") or {}).get("id")
            if group_id is not None and str(group_id) in ignored:
                continue
            lat, lon = entry.get("latitude"), entry.get("longitude")
            if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and (lat or lon):
                points.append((float(lat), float(lon)))
        return points

    async def load_state(self) -> dict:
        try:
            aggregate = await self.api.fetch_channel_aggregate(RADAR_CHANNEL)
        except Exception:
            # No channel yet: the first message creates it.
            return {}
        return aggregate.data or {}

    async def refresh_radar(self):
        cfg = self.config.radar
        if not cfg.enabled.value:
            return
        try:
            await self._refresh_radar(cfg)
        except Exception as e:
            log.exception("Radar refresh failed: %s", e)

    async def create_radar_message(self, data: dict, time_ms: int, files: list[File], ttl_secs: int):
        """Post one slot's radar images with a TTL.

        pydoover's create_message doesn't take a TTL yet, but the API reads
        ``ttl`` (seconds from now) from the same JSON body, which the client
        sends as-is alongside the attachments.
        """
        await self.api._request(
            "POST",
            f"/agents/{self.agent_id}/channels/{RADAR_CHANNEL}/messages",
            data={"data": data, "ts": time_ms, "ttl": ttl_secs},
            files=files,
        )

    def radar_site_ids(self, cfg, range_digit: int, available: set[str]) -> list[int]:
        """The configured radars, else the one nearest the gauges."""
        text = (cfg.site.value or "").strip()
        if text:
            try:
                ids = radar.parse_site_ids(text)
            except ValueError:
                log.warning("Radar Sites %r isn't a list of radar IDs", text)
                return []
            missing = [i for i in ids if radar.product_code(i, range_digit) not in available]
            if missing:
                log.warning("No %s images on the feed for radars %s", cfg.range.value, missing)
            return [i for i in ids if i not in missing]
        centre = radar.centroid(self.gauge_points())
        nearest = radar.nearest_site(*centre, range_digit, available) if centre else None
        return [nearest] if nearest is not None else []

    async def _refresh_radar(self, cfg):
        range_digit = radar.RANGES.get(cfg.range.value, 3)
        range_km = int(cfg.range.value.split()[0])
        state = await self.load_state()
        last: dict[str, int] = dict(state.get("last") or {})
        known = {s["product"]: s for s in (state.get("sites") or []) if s.get("map")}

        ftp = await asyncio.to_thread(
            radar.RadarFtp, cfg.host.value, cfg.username.value, cfg.password.value
        )
        try:
            names = await asyncio.to_thread(ftp.list, cfg.directory.value)
            frames = radar.parse_frames(names)

            # Each radar's georeference, fetched once per product.
            sites = []
            for site_id in self.radar_site_ids(cfg, range_digit, set(frames)):
                product = radar.product_code(site_id, range_digit)
                site = known.get(product)
                if site is None:
                    text = await asyncio.to_thread(
                        ftp.read, f"{cfg.coordinates_directory.value}/{product}.map"
                    )
                    name, lat, lon = radar.SITES.get(site_id, (f"Radar {site_id}", None, None))
                    site = {
                        "product": product,
                        "site_id": site_id,
                        "name": name,
                        "range_km": range_km,
                        "map": radar.parse_map(text.decode("latin-1")),
                    }
                sites.append(site)

            wanted = [("local", s["product"]) for s in sites]
            if cfg.national.value:
                wanted.append(("national", radar.NATIONAL_PRODUCT))

            keep = timedelta(days=float(cfg.keep_days.value))
            cutoff_ms = int((datetime.now(timezone.utc) - keep).timestamp() * 1000)
            new = [
                (kind, frame)
                for kind, product in wanted
                for frame in frames.get(product, [])
                if frame.time_ms > max(last.get(product, 0), cutoff_ms)
            ]
            stored = 0
            for slot, items in radar.group_by_slot(new).items():
                files, entries = [], []
                for kind, frame in items:
                    data = await asyncio.to_thread(ftp.read, f"{cfg.directory.value}/{frame.filename}")
                    files.append(File(frame.filename, "image/png", len(data), data))
                    entries.append(
                        {"kind": kind, "product": frame.product, "time": frame.time_ms, "file": frame.filename}
                    )
                await self.create_radar_message(
                    {"radar": {"slot": slot, "frames": entries}},
                    slot,
                    files,
                    int(keep.total_seconds()),
                )
                for kind, frame in items:
                    last[frame.product] = max(last.get(frame.product, 0), frame.time_ms)
                stored += len(items)
        finally:
            await asyncio.to_thread(ftp.close)

        await self.api.update_channel_aggregate(
            RADAR_CHANNEL,
            {
                "sites": sites,
                "national": {"product": radar.NATIONAL_PRODUCT} if cfg.national.value else None,
                # Only products still in use, so a dropped radar doesn't linger.
                "last": {p: t for p, t in last.items() if p in {pr for _, pr in wanted}},
                "keep_days": float(cfg.keep_days.value),
            },
            replace_data=True,
            suppress_response=True,
            return_aggregate=False,
        )
        log.info("Stored %d new radar images (%s)", stored, ", ".join(p for _, p in wanted))
