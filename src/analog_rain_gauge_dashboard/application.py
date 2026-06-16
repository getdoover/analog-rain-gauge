import logging
from datetime import datetime, timezone

from pydoover.models.data.connection import ConnectionDisplay
from pydoover.processor import Application
from pydoover.models import (
    ConnectionStatus,
    ConnectionDetermination,
    DeploymentEvent,
    ConnectionConfig,
    ConnectionType,
)

from .app_config import AnalogRainGaugeDashboardConfig
from .app_ui import AnalogRainGaugeDashboardUI

log = logging.getLogger(__name__)


class AnalogRainGaugeDashboardApp(Application):
    """Farm dashboard for devices running Analog Rain Gauge.

    This processor does no per-device work. All of the aggregation — farm
    average / wettest / driest, the per-gauge table, the rainfall-over-time
    chart and the interpolated rainfall heatmap over a satellite basemap — runs
    client side in the ``RainfallDashboardWidget`` remote component, which reads
    each gauge's `daily` rainfall totals and live `since_9am` tag directly.

    The processor exists only to host that widget (via the static UI schema)
    and to keep the dashboard's own agent looking online whenever it is
    (re)deployed.
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
