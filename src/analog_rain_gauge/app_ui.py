from pathlib import Path

from pydoover import ui

from .app_tags import AnalogRainGaugeTags


class AnalogRainGaugeUI(ui.UI):
    widget = ui.RemoteComponent(
        "Rainfall Chart",
        component_url="$config.app().dv_widget_url",
        scope="RainfallWidget",
        module="./RainfallWidget",
        app_key="$config.app().APP_KEY",
    )

    since_9am = ui.NumericVariable(
        "Since 9am", value=AnalogRainGaugeTags.since_9am, precision=2, units="mm"
    )
    since_event = ui.NumericVariable(
        "Since Event Start",
        value=AnalogRainGaugeTags.since_event,
        precision=2,
        units="mm",
    )
    total_rainfall = ui.NumericVariable(
        "Total Rainfall",
        value=AnalogRainGaugeTags.total_rainfall,
        precision=2,
        units="mm",
    )

    intensity = ui.NumericVariable(
        "Rain Intensity",
        value=AnalogRainGaugeTags.intensity,
        precision=2,
        units="mm/hr",
    )

    event_started = ui.Timestamp(
        "Event Started",
        value=AnalogRainGaugeTags.event_started,
    )

    actions = ui.Submodule(
        "Actions",
        children=[
            ui.FloatInput(
                "Set Total Rainfall",
                min_val=0,
                requires_confirm=True,
                units="mm",
            ),
            ui.Button(
                "Reset Event",
                requires_confirm=True,
            ),
        ],
        is_collapsed=True,
    )


def export():
    AnalogRainGaugeUI(None, None, None).export(
        Path(__file__).parents[2] / "doover_config.json",
        "analog_rain_gauge",
    )
