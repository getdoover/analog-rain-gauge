import logging
from datetime import datetime, timezone, timedelta

from pydoover import ui
from pydoover.docker import Application

from .app_config import AnalogRainGaugeConfig
from .app_tags import AnalogRainGaugeTags
from .app_ui import AnalogRainGaugeUI

log = logging.getLogger()


class AnalogRainGaugeApplication(Application):
    config: AnalogRainGaugeConfig
    tags: AnalogRainGaugeTags

    config_cls = AnalogRainGaugeConfig
    tags_cls = AnalogRainGaugeTags
    ui_cls = AnalogRainGaugeUI

    async def setup(self):
        self.loop_target_period = 3.0

        if self.tags.last_9am_reset.value is None:
            await self.tags.last_9am_reset.set(
                datetime.now(timezone.utc).astimezone().timestamp()
            )

        events = await self.platform_iface.fetch_di_events(
            int(self.config.input_pin.value),
            edge="rising",
            events_from=self.tags.last_pulse_io_board.value,
        )
        for event in events:
            await self.on_gauge_pulse(event)

        self.platform_iface.start_di_pulse_listener(
            int(self.config.input_pin.value), self.on_gauge_pulse, "rising"
        )

    async def main_loop(self):
        await self.check_event_done()
        await self.check_9am_reset()

        await self.ensure_output_pin()

        if (
            self.tags.event_started.value is None
            and self.tags.since_event.value
            >= self.config.event_rainfall_threshold.value
        ):
            await self.start_event()

        await self.tags.intensity.set(self._calc_intensity())

    async def ensure_output_pin(self):
        if self.config.output_pin.value is None:
            log.debug("No output pin configured, skipping")
            return
        await self.platform_iface.set_do(int(self.config.output_pin.value), True)

    async def check_9am_reset(self):
        now = datetime.now(timezone.utc).astimezone()
        last_9am_reset = self.tags.last_9am_reset.value
        if last_9am_reset:
            as_dt = datetime.fromtimestamp(last_9am_reset, tz=now.tzinfo)
            needs_reset = as_dt.date() < now.date() and now.hour > 9
        else:
            needs_reset = False

        if needs_reset:
            daily_total = self.tags.since_9am.value
            reset_date = as_dt.date().isoformat()
            log.info(
                "Resetting rainfall since 9am (%.2fmm on %s)", daily_total, reset_date
            )

            await self.device_agent.create_message(
                self.app_key,
                {
                    "daily": {
                        "type": "daily",
                        "date": reset_date,
                        "total_mm": round(daily_total, 2),
                        "timestamp": int(now.timestamp() * 1000),
                    },
                },
            )

            await self.tags.since_9am.set(0)
            await self.tags.last_9am_reset.set(now.timestamp())

    async def on_gauge_pulse(self, *args, **kwargs):
        log.info("Received pulse from rain gauge")
        per_pulse = self.config.mm_per_pulse.value
        await self.tags.since_9am.set(self.tags.since_9am.value + per_pulse)
        await self.tags.since_event.set(self.tags.since_event.value + per_pulse)
        await self.tags.total_rainfall.set(self.tags.total_rainfall.value + per_pulse)

        now = datetime.now(timezone.utc)
        await self.tags.prev_pulse_dt.set(self.tags.last_pulse_dt.value)

        await self.device_agent.create_message(
            self.app_key,
            {
                "pulse": {
                    "type": "pulse",
                    "mm": per_pulse,
                    "timestamp": int(now.timestamp() * 1000),
                },
            },
        )

        # fixme: set this to the IO board time in ms or include time with the pulse event
        await self.tags.last_pulse_io_board.set(0)
        await self.tags.last_pulse_dt.set(now.timestamp())

    def _calc_intensity(self):
        """Calculate rain intensity (mm/hr) based on time between last 2 pulses."""
        prev = self.tags.prev_pulse_dt.value
        last = self.tags.last_pulse_dt.value

        if not prev or not last or last <= prev:
            return 0.0

        gap_hours = (last - prev) / 3600
        per_pulse = self.config.mm_per_pulse.value
        return per_pulse / gap_hours

    async def start_event(self):
        log.info("Starting new rainfall event")
        now = datetime.now(timezone.utc).astimezone()
        await self.tags.event_started.set(now.timestamp())

    async def check_event_done(self):
        dt = self.tags.last_pulse_dt.value
        if not dt:
            return
        since_event = self.tags.since_event.value
        if since_event is None:
            return

        if since_event < self.config.event_rainfall_threshold.value:
            log.info("Minimum threshold not met, skipping event")
            return

        last_pulse = datetime.fromtimestamp(dt, tz=timezone.utc)
        if datetime.now(timezone.utc) - last_pulse > timedelta(
            hours=self.config.event_completion_duration.value
        ):
            event_total = since_event
            event_started = self.tags.event_started.value
            event_started_dt = datetime.fromtimestamp(event_started, tz=timezone.utc)
            duration_hours = (last_pulse - event_started_dt).total_seconds() / 3600

            log.info("Event completed, resetting event rainfall")
            await self.create_message(
                "notifications",
                {"message": f"Rainfall: {event_total:.2f}mm in latest event."},
            )

            await self.device_agent.create_message(
                self.app_key,
                {
                    "event": {
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
                },
            )

            await self.tags.since_event.set(0)
            await self.tags.event_started.set(None)
            await self.tags.last_pulse_dt.set(None)

    @ui.handler("set_total_rainfall", parser=int)
    async def on_set_total(self, ctx, value: int):
        log.info("Setting total rainfall to %.2f", value)
        await self.tags.total_rainfall.set(value)
        await self.ui.set_total.set(0)

    @ui.handler("reset_event")
    async def on_reset_event(self, ctx, value):
        log.info("Resetting event rainfall")
        await self.tags.since_event.set(0)
        await self.tags.event_started.set(None)

        await self.ui.reset_event.set(0)
