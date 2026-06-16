from pathlib import Path

from pydoover import ui


class AnalogRainGaugeDashboardUI(ui.UI, default_open=True):
    widget = ui.RemoteComponent(
        name="RainfallDashboard",
        display_name="Rainfall Dashboard",
        component_url="$config.app().dv_widget_url",
        scope="RainfallDashboardWidget",
        module="./RainfallDashboardWidget",
        # The dashboard agent's deployment config holds the DEVICE_MAP under
        # this app's key (populated from the extended-permissions config). Each
        # entry carries the gauge's lat/long and its `app_installs` — the widget
        # reads those per-device rather than hardcoding any gauge keys.
        app_key="$config.app().APP_KEY",
    )


def export():
    AnalogRainGaugeDashboardUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "analog_rain_gauge_dashboard",
    )
