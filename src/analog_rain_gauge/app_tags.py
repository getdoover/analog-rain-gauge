from pydoover.tags import Tag, Tags, Delta


class AnalogRainGaugeTags(Tags):
    since_event = Tag("number", default=0)
    since_9am = Tag("number", default=0, log_on=Delta(amount=1.0))
    total_rainfall = Tag("number", default=0, log_on=Delta(amount=1.0))
    last_9am_reset = Tag("number", default=None)
    event_started = Tag("number", default=None)
    prev_pulse_dt = Tag("number", default=None)
    last_pulse_dt = Tag("number", default=None)
    last_pulse_io_board = Tag("number", default=0)
    intensity = Tag("number", default=0)
