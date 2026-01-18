from pathlib import Path

from pydoover import config


class AnalogRainGaugeConfig(config.Schema):
    def __init__(self):
        self.input_pin = config.Integer(
            "Input Pin", description="Input pin connected to the rain gauge.", minimum=0
        )
        self.output_pin = config.Integer(
            "Output Pin", description="(Optional) Output DO output pin connected to the rain gauge.", minimum=0,
            default=None
        )
        self.mm_per_pulse = config.Number(
            "Millimeters per Pulse",
            description="The number of millimeters of rain per pulse from the gauge.",
            default=0.2,
            minimum=0,
        )

        self.event_rainfall_threshold = config.Number(
            "Event Rainfall Threshold",
            description="The amount of rainfall that triggers an event (mm).",
            default=1.0,
            minimum=0,
        )
        self.event_completion_duration = config.Integer(
            "Event Completion Duration",
            description="The numer of hours of no rainfall to consider an event finished.",
            default=24,
            minimum=0,
        )


def export():
    AnalogRainGaugeConfig().export(Path(__file__).parents[2] / "doover_config.json", "analog_rain_gauge")

if __name__ == "__main__":
    export()