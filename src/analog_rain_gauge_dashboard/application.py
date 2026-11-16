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

    - each image is one message (``{"local"|"national": {product, time}}``,
      timestamped at the radar time) with the PNG attached;
    - the aggregate holds the site and each product's georeference, plus the
      newest stored time per product so a run only fetches what's new;
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
        """(lat, lon) of every located gauge in this dashboard's DEVICE_MAP."""
        device_map = (self.received_deployment_config or {}).get("DEVICE_MAP") or {}
        points = []
        for entry in device_map.values():
            if not isinstance(entry, dict):
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

    async def create_radar_message(self, data: dict, time_ms: int, file: File, ttl_secs: int):
        """Post one radar image with a TTL.

        pydoover's create_message doesn't take a TTL yet, but the API reads
        ``ttl`` (seconds from now) from the same JSON body, which the client
        sends as-is alongside the attachment.
        """
        await self.api._request(
            "POST",
            f"/agents/{self.agent_id}/channels/{RADAR_CHANNEL}/messages",
            data={"data": data, "ts": time_ms, "ttl": ttl_secs},
            files=[file],
        )

    async def _refresh_radar(self, cfg):
        range_digit = radar.RANGES.get(cfg.range.value, 3)
        state = await self.load_state()
        last: dict[str, int] = dict(state.get("last") or {})

        ftp = await asyncio.to_thread(
            radar.RadarFtp, cfg.host.value, cfg.username.value, cfg.password.value
        )
        try:
            names = await asyncio.to_thread(ftp.list, cfg.directory.value)
            frames = radar.parse_frames(names)

            # Which site: configured, else nearest to the gauges.
            site_id = None
            site_text = (cfg.site.value or "").strip().upper().removeprefix("IDR")
            if site_text:
                try:
                    site_id = int(site_text)
                except ValueError:
                    log.warning("Radar site %r is not a radar ID", cfg.site.value)
            else:
                centre = radar.centroid(self.gauge_points())
                if centre:
                    site_id = radar.nearest_site(*centre, range_digit, set(frames))

            local_product = radar.product_code(site_id, range_digit) if site_id is not None else None
            if local_product and local_product not in frames:
                log.warning("No %s images on the feed", local_product)

            # Georeference for the local product, fetched once per product.
            local = state.get("local") or {}
            if local_product and local.get("product") != local_product:
                text = await asyncio.to_thread(
                    ftp.read, f"{cfg.coordinates_directory.value}/{local_product}.map"
                )
                name, lat, lon = radar.SITES.get(site_id, (f"Radar {site_id}", None, None))
                local = {
                    "product": local_product,
                    "site_id": site_id,
                    "name": name,
                    "range_km": int(cfg.range.value.split()[0]),
                    "map": radar.parse_map(text.decode("latin-1")),
                }
            elif not local_product:
                local = {}

            wanted = []
            if local_product:
                wanted.append(("local", local_product))
            if cfg.national.value:
                wanted.append(("national", radar.NATIONAL_PRODUCT))

            keep = timedelta(days=float(cfg.keep_days.value))
            cutoff_ms = int((datetime.now(timezone.utc) - keep).timestamp() * 1000)
            stored = 0
            for kind, product in wanted:
                for frame in frames.get(product, []):
                    if frame.time_ms <= max(last.get(product, 0), cutoff_ms):
                        continue
                    data = await asyncio.to_thread(ftp.read, f"{cfg.directory.value}/{frame.filename}")
                    await self.create_radar_message(
                        {kind: {"product": product, "time": frame.time_ms}},
                        frame.time_ms,
                        File(frame.filename, "image/png", len(data), data),
                        int(keep.total_seconds()),
                    )
                    last[product] = frame.time_ms
                    stored += 1
        finally:
            await asyncio.to_thread(ftp.close)

        await self.api.update_channel_aggregate(
            RADAR_CHANNEL,
            {
                "local": local or None,
                "national": {"product": radar.NATIONAL_PRODUCT} if cfg.national.value else None,
                "last": last,
                "keep_days": float(cfg.keep_days.value),
            },
            replace_data=True,
            suppress_response=True,
            return_aggregate=False,
        )
        log.info("Stored %d new radar images (%s)", stored, ", ".join(p for _, p in wanted))
