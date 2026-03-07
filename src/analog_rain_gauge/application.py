import logging
from datetime import datetime, timezone, timedelta

from pydoover.docker import Application
from pydoover.ui import RemoteComponent

from .app_config import AnalogRainGaugeConfig
from .app_ui import AnalogRainGaugeUI

log = logging.getLogger()


class AnalogRainGaugeApplication(Application):
    config: AnalogRainGaugeConfig
    ui: AnalogRainGaugeUI

    async def setup(self):
        self.loop_target_period = 3.0

        self.ui = AnalogRainGaugeUI(self.app_key)
        self.ui_manager.add_children(
            *self.ui.fetch(),
        )

        if self.get_tag("since_event") is None:
            await self.set_tag_async("since_event", 0)
        if self.get_tag("since_9am") is None:
            await self.set_tag_async("since_9am", 0)
        if self.get_tag("total_rainfall") is None:
            await self.set_tag_async("total_rainfall", 0)
        if self.get_tag("last_9am_reset") is None:
            await self.set_tag_async(
                "last_9am_reset", datetime.now(timezone.utc).astimezone().timestamp()
            )

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
        await self.check_set_total()
        await self.check_reset_event()
        await self.check_event_done()
        await self.check_9am_reset()

        await self.ensure_output_pin()

        if (
            self.get_tag("event_started") is None
            and self.get_tag("since_event")
            >= self.config.event_rainfall_threshold.value
        ):
            await self.start_event()

        event_started = self.get_tag("event_started")
        ts = event_started and datetime.fromtimestamp(event_started).astimezone()

        intensity = self._calc_intensity()

        self.ui.update(
            self.get_tag("since_9am"),
            self.get_tag("since_event"),
            self.get_tag("total_rainfall"),
            event_started and f"{ts:%a %I:%M%p} ({ts.tzinfo.tzname(ts)})",
            intensity,
        )

    async def ensure_output_pin(self):
        if self.config.output_pin.value is None:
            log.debug("No output pin configured, skipping")
            return
        await self.platform_iface.set_do_async(self.config.output_pin.value, True)

    async def check_9am_reset(self):
        now = datetime.now(timezone.utc).astimezone()
        last_9am_reset = self.get_tag("last_9am_reset")
        if last_9am_reset:
            as_dt = datetime.fromtimestamp(last_9am_reset, tz=now.tzinfo)
            needs_reset = as_dt.date() < now.date() and now.hour > 9
        else:
            needs_reset = False

        if needs_reset:
            daily_total = self.get_tag("since_9am")
            reset_date = as_dt.date().isoformat()
            log.info(
                "Resetting rainfall since 9am (%.2fmm on %s)", daily_total, reset_date
            )

            await self.device_agent.create_message(
                self.app_key,
                {
                    "daily": True,
                    "type": "daily",
                    "date": reset_date,
                    "total_mm": round(daily_total, 2),
                    "timestamp": int(now.timestamp() * 1000),
                },
            )

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

        now = datetime.now(timezone.utc)
        await self.set_tag_async("prev_pulse_dt", self.get_tag("last_pulse_dt"))

        await self.device_agent.create_message(
            self.app_key,
            {
                "pulse": True,
                "type": "pulse",
                "mm": per_pulse,
                "timestamp": int(now.timestamp() * 1000),
            },
        )

        # fixme: set this to the IO board time in ms or include time with the pulse event
        await self.set_tag_async("last_pulse_io_board", 0)
        await self.set_tag_async("last_pulse_dt", now.timestamp())

    def _calc_intensity(self):
        """Calculate rain intensity (mm/hr) based on time between last 2 pulses."""
        prev = self.get_tag("prev_pulse_dt")
        last = self.get_tag("last_pulse_dt")

        if not prev or not last or last <= prev:
            return 0.0

        gap_hours = (last - prev) / 3600
        per_pulse = self.config.mm_per_pulse.value
        return per_pulse / gap_hours

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
            event_total = self.ui.since_event.current_value
            event_started = self.get_tag("event_started")
            event_started_dt = datetime.fromtimestamp(event_started, tz=timezone.utc)
            duration_hours = (last_pulse - event_started_dt).total_seconds() / 3600

            log.info("Event completed, resetting event rainfall")
            await self.publish_to_channel(
                "notifications",
                {"message": f"Rainfall: {event_total:.2f}mm in latest event."},
            )

            await self.device_agent.create_message(
                self.app_key,
                {
                    "event": True,
                    "type": "event",
                    "started": event_started_dt.astimezone().isoformat(),
                    "ended": last_pulse.astimezone().isoformat(),
                    "total_mm": round(event_total, 2),
                    "duration_hours": round(duration_hours, 2),
                    "intensity_mm_hr": round(
                        event_total / max(duration_hours, 0.01), 2
                    ),
                    "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                },
            )

            await self.set_tag_async("since_event", 0)
            await self.set_tag_async("event_started", None)
            await self.set_tag_async("last_pulse_dt", None)

    async def check_set_total(self):
        val = self.ui.set_total.current_value
        if val is not None:
            log.info("Setting total rainfall to %.2f", val)
            await self.set_tag_async("total_rainfall", val)
            self.ui.set_total.coerce(None)

    async def check_reset_event(self):
        if self.ui.reset_event.current_value is True:
            log.info("Resetting event rainfall")
            await self.set_tag_async("since_event", 0)
            await self.set_tag_async("event_started", None)

            self.ui.reset_event.coerce(None)
