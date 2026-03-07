from pydoover import ui


class AnalogRainGaugeUI:
    def __init__(self):
        self.since_9am = ui.NumericVariable(
            "rainfall_since_9am", "Since 9am (mm)", precision=2
        )
        self.since_event = ui.NumericVariable(
            "rainfall_since_event", "Since Event Start (mm)", precision=2
        )
        self.total_rainfall = ui.NumericVariable(
            "total_rainfall", "Total Rainfall (mm)", precision=2
        )

        self.intensity = ui.NumericVariable(
            "rain_intensity", "Rain Intensity (mm/hr)", precision=2
        )

        self.event_started = ui.TextVariable("event_started", "Event Started")

        self.set_total = ui.NumericParameter(
            "set_total_rainfall",
            "Set Total Rainfall (mm)",
            min_val=0,
            requires_confirm=True,
        )

        self.reset_event = ui.Action(
            "reset_event", "Reset Event", requires_confirm=True
        )

        self.actions = ui.Submodule(
            "rain_gauge_actions",
            "Actions",
            children=[self.set_total, self.reset_event],
            is_collapsed=True,
        )

    def fetch(self):
        return (
            self.since_9am,
            self.since_event,
            self.total_rainfall,
            self.intensity,
            self.event_started,
            self.actions,
        )

    def update(
        self,
        since_9am: float,
        since_event: float,
        total_rainfall: float,
        event_started: str,
        intensity: float,
    ):
        self.since_9am.update(since_9am)
        self.since_event.update(since_event)
        self.total_rainfall.update(total_rainfall)
        self.intensity.update(intensity)
        self.event_started.update(event_started)
