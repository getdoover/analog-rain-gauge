from pydoover.processor import run_app

from .application import AnalogRainGaugeDashboardApp
from .app_config import AnalogRainGaugeDashboardConfig


def handler(event, context):
    """Lambda handler entry point."""
    AnalogRainGaugeDashboardConfig.clear_elements()
    return run_app(
        AnalogRainGaugeDashboardApp(),
        event,
        context,
    )
