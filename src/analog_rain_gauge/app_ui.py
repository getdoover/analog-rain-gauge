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


        self.event_started = ui.TextVariable("event_started", "Event Started")
        self.reset_event = ui.Action(
            "reset_event", "Reset Event", confirmation=True
        )
        self.reset_total = ui.Action(
            "reset_total", "Reset Total Rainfall", confirmation=True
        )

    def fetch(self):
        return (
            self.since_9am,
            self.since_event,
            self.total_rainfall,
            self.event_started,
            self.reset_event,
            self.reset_total,
        )

    def update(self):
        pass
