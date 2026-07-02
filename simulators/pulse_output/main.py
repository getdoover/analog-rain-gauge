import asyncio
import logging
import os
import time
from datetime import datetime

from pydoover.docker import Application, run_app
from pydoover.config import Schema


# --- Pulse configuration -----------------------------------------------------
# Digital output pin to pulse.
DO_PIN = int(os.environ.get("DO_PIN", 0))
# How many pulses make up a single burst.
PULSE_COUNT = int(os.environ.get("PULSE_COUNT", 5))
# How long the output is held high for each pulse.
PULSE_HIGH_SECS = float(os.environ.get("PULSE_HIGH_SECS", 1.0))
# Gap between consecutive pulses (the "1 sec between" spacing).
PULSE_GAP_SECS = float(os.environ.get("PULSE_GAP_SECS", 1.0))
# How often to run a burst. Default: every 10 days.
BURST_INTERVAL_SECS = float(os.environ.get("BURST_INTERVAL_SECS", 10 * 24 * 60 * 60))
# How often to log the countdown while idle.
REPORT_INTERVAL_SECS = float(os.environ.get("REPORT_INTERVAL_SECS", 15))

# Tags used to persist the schedule across sleep/wake cycles. The epoch tag is
# authoritative; the ISO tag is a human-readable mirror for the dashboard.
NEXT_BURST_EPOCH_TAG = "next_burst_epoch"
NEXT_BURST_TIME_TAG = "next_burst_time"

log = logging.getLogger()


def human_duration(secs: float) -> str:
    secs = max(0, int(secs))
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, seconds = divmod(rem, 60)
    return f"{days}d {hours:02d}h {minutes:02d}m {seconds:02d}s"


def iso(epoch: float) -> str:
    # Device local time (compose mounts /etc/localtime).
    return datetime.fromtimestamp(epoch).isoformat(timespec="seconds")


class PulseOutputApp(Application):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Wake up often enough to emit the countdown on schedule.
        self.loop_target_period = REPORT_INTERVAL_SECS

    async def setup(self):
        log.info(
            "Pulse output app: DO%d, %d pulses (%.1fs high / %.1fs gap) every %s",
            DO_PIN,
            PULSE_COUNT,
            PULSE_HIGH_SECS,
            PULSE_GAP_SECS,
            human_duration(BURST_INTERVAL_SECS),
        )
        # Start from a known-low state.
        await self.set_do(DO_PIN, False)

        # The doovit sleeps and wakes, so the schedule lives in a persisted tag
        # (absolute wall-clock epoch) rather than in process memory.
        next_epoch = self.get_tag(NEXT_BURST_EPOCH_TAG)
        if next_epoch is None:
            # First run ever: schedule "now" so the first burst fires on the
            # first main loop and the wiring can be confirmed straight away.
            log.info("No saved schedule found - firing an initial burst now.")
            await self.schedule_next(time.time())
        else:
            log.info(
                "Resuming saved schedule: next burst at %s (in %s)",
                iso(next_epoch),
                human_duration(next_epoch - time.time()),
            )

    async def main_loop(self):
        now = time.time()
        next_epoch = self.get_tag(NEXT_BURST_EPOCH_TAG)
        if next_epoch is None:
            # Shouldn't happen after setup, but never sit idle without a schedule.
            await self.schedule_next(now)
            return

        if now >= next_epoch:
            await self.do_burst()
            await self.schedule_next(time.time() + BURST_INTERVAL_SECS)
        else:
            log.info(
                "Next pulse burst in %s (at %s)",
                human_duration(next_epoch - now),
                iso(next_epoch),
            )

    async def schedule_next(self, epoch: float):
        await self.set_tag(NEXT_BURST_EPOCH_TAG, epoch)
        await self.set_tag(NEXT_BURST_TIME_TAG, iso(epoch))
        log.info("Next burst scheduled for %s", iso(epoch))

    async def do_burst(self):
        log.info("Starting pulse burst: %d pulses on DO%d", PULSE_COUNT, DO_PIN)
        for i in range(1, PULSE_COUNT + 1):
            await self.set_do(DO_PIN, True)
            await asyncio.sleep(PULSE_HIGH_SECS)
            await self.set_do(DO_PIN, False)
            log.info("Pulse %d/%d done", i, PULSE_COUNT)
            if i < PULSE_COUNT:
                await asyncio.sleep(PULSE_GAP_SECS)
        log.info("Pulse burst complete")


def main():
    """Run the pulse output application."""
    run_app(PulseOutputApp())

if __name__ == "__main__":
    main()