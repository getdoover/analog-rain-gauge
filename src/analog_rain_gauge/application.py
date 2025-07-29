import logging
from datetime import datetime, timezone, timedelta

from pydoover.docker import Application

from .app_config import AnalogRainGaugeConfig
from .app_ui import AnalogRainGaugeUI

log = logging.getLogger()


class AnalogRainGaugeApplication(Application):
    config: AnalogRainGaugeConfig
    ui: AnalogRainGaugeUI

    async def setup(self):
        self.ui = AnalogRainGaugeUI()
        self.ui_manager.add_children(*self.ui.fetch())

        if self.get_tag("since_event") is None:
            await self.set_tag_async("since_event", 0)
        if self.get_tag("since_9am") is None:
            await self.set_tag_async("since_9am", 0)
        if self.get_tag("total_rainfall") is None:
            await self.set_tag_async("total_rainfall", 0)

        events = await self.platform_iface.get_di_events_async(
            self.config.input_pin.value,
            edge="rising",
            events_from=self.get_tag("last_pulse_io_board") or 0,
        )
        for event in events:
            await self.on_gauge_pulse(event)

        self.platform_iface.start_di_pulse_listener(
            self.config.input_pin.value, self.on_gauge_pulse, "rising"
        )

        # fixme: remove once the display name is set in the config properly
        self.ui_manager.set_display_name("Rain Gauge")

    async def main_loop(self):
        await self.check_reset_total()
        await self.check_reset_event()
        await self.check_event_done()
        await self.check_9am_reset()

        if (
            self.get_tag("event_started") is None
            and self.get_tag("since_event")
            >= self.config.event_rainfall_threshold.value
        ):
            await self.start_event()

        event_started = self.get_tag("event_started")
        ts = event_started and datetime.fromtimestamp(event_started).astimezone()
        self.ui.update(
            self.get_tag("since_9am"),
            self.get_tag("since_event"),
            self.get_tag("total_rainfall"),
            event_started and f"{ts:%a %I:%M%p} ({ts.tzinfo.tzname(ts)})",
        )

    async def check_9am_reset(self):
        now = datetime.now(timezone.utc).astimezone()
        last_9am_reset = self.get_tag("last_9am_reset")
        if last_9am_reset:
            as_dt = datetime.fromtimestamp(last_9am_reset, tz=now.tzinfo)
            needs_reset = as_dt.date() < now.date() and now.hour > 9
        else:
            needs_reset = False

        if needs_reset:
            log.info("Resetting rainfall since 9am")
            await self.set_tag_async("since_9am", 0)
            await self.set_tag_async("last_9am_reset", now.timestamp())

    async def on_gauge_pulse(self, *args, **kwargs):
        log.info("Received pulse from rain gauge")
        per_pulse = self.config.mm_per_pulse.value
        await self.set_tag_async("since_9am", self.get_tag("since_9am") + per_pulse)
        await self.set_tag_async("since_event", self.get_tag("since_event") + per_pulse)
        await self.set_tag_async(
            "total_rainfall", self.get_tag("total_rainfall") + per_pulse
        )

        # fixme: set this to the IO board time in ms or include time with the pulse event
        await self.set_tag_async("last_pulse_io_board", 0)
        await self.set_tag_async(
            "last_pulse_dt", datetime.now(timezone.utc).timestamp()
        )

    async def start_event(self):
        log.info("Starting new rainfall event")
        now = datetime.now(timezone.utc).astimezone()
        await self.set_tag_async("event_started", now.timestamp())

    async def check_event_done(self):
        dt = self.get_tag("last_pulse_dt")
        if not dt:
            return
        if self.ui.since_event.current_value is None:
            return

        if (
            self.ui.since_event.current_value
            < self.config.event_rainfall_threshold.value
        ):
            log.info("Minimum threshold not met, skipping event")
            return

        last_pulse = datetime.fromtimestamp(dt, tz=timezone.utc)
        if datetime.now(timezone.utc) - last_pulse > timedelta(
            hours=self.config.event_completion_duration.value
        ):
            log.info("Event completed, resetting event rainfall")
            await self.publish_to_channel(
                "significantEvent",
                f"Rainfall: {self.ui.since_event.current_value:.2f}mm in latest event.",
            )

            await self.set_tag_async("since_event", 0)
            await self.set_tag_async("event_started", None)
            await self.set_tag_async("last_pulse_dt", None)

    async def check_reset_total(self):
        if self.ui.reset_total.current_value is True:
            log.info("Resetting total rainfall")
            await self.set_tag_async("total_rainfall", 0)
            self.ui.reset_total.coerce(None)

    async def check_reset_event(self):
        if self.ui.reset_event.current_value is True:
            log.info("Resetting event rainfall")
            await self.set_tag_async("since_event", 0)
            await self.set_tag_async("event_started", None)

            self.ui.reset_event.coerce(None)
