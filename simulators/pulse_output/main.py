import asyncio
import logging
import os
import random
import time
from datetime import datetime

from pydoover.docker import Application, run_app


# How long each output is held high for a single pulse.
PULSE_HIGH_SECS = float(os.environ.get("PULSE_HIGH_SECS", 1.0))
# How often to log the idle countdown for each output.
REPORT_INTERVAL_SECS = float(os.environ.get("REPORT_INTERVAL_SECS", 15))
# How often the main loop wakes to check the schedule. Must be small enough to
# honour DO1's minimum interval while the device is awake.
LOOP_PERIOD_SECS = float(os.environ.get("LOOP_PERIOD_SECS", 1.0))
# Channel every DO set is recorded to, so the driven pulses can be cross-checked
# against whatever counts the voltage input downstream.
LOG_CHANNEL = os.environ.get("LOG_CHANNEL", "pulse_output_log")

# Output pins are fixed: DO 0 -> pin 0, DO 1 -> pin 1.
# --- DO 0: heartbeat pulse, once every 10 days -------------------------------
DO0_INTERVAL_SECS = float(os.environ.get("DO0_INTERVAL_SECS", 10 * 24 * 60 * 60))

# --- DO 1: one pulse at a random interval between 1s and 1hr ------------------
DO1_MIN_INTERVAL_SECS = float(os.environ.get("DO1_MIN_INTERVAL_SECS", 1))
DO1_MAX_INTERVAL_SECS = float(os.environ.get("DO1_MAX_INTERVAL_SECS", 60 * 60))

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


class PulseChannel:
    """A single digital output pulsing on its own schedule.

    The schedule is kept in persisted tags (absolute wall-clock epoch) so it
    survives the doovit sleeping/waking between pulses rather than living in
    process memory. `next_interval` returns the seconds until the *next* pulse,
    letting DO0 use a fixed cadence and DO1 use a fresh random gap each time.
    """

    def __init__(self, label, pin, next_interval, describe):
        self.label = label
        self.pin = pin
        self.next_interval = next_interval  # () -> secs until next pulse
        self.describe = describe            # () -> human description of cadence
        self.epoch_tag = f"next_pulse_epoch_{label}"
        self.time_tag = f"next_pulse_time_{label}"
        self.last_report = 0.0


CHANNELS = [
    PulseChannel(
        "do0",
        0,
        next_interval=lambda: DO0_INTERVAL_SECS,
        describe=lambda: f"every {human_duration(DO0_INTERVAL_SECS)}",
    ),
    PulseChannel(
        "do1",
        1,
        next_interval=lambda: random.uniform(DO1_MIN_INTERVAL_SECS, DO1_MAX_INTERVAL_SECS),
        describe=lambda: (
            f"randomly every {human_duration(DO1_MIN_INTERVAL_SECS)}"
            f" - {human_duration(DO1_MAX_INTERVAL_SECS)}"
        ),
    ),
]


class PulseOutputApp(Application):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Wake up often enough to honour the shortest configured interval.
        self.loop_target_period = LOOP_PERIOD_SECS

    async def setup(self):
        for ch in CHANNELS:
            log.info(
                "Pulse output: DO%d (%s) pulses %s (%.1fs high)",
                ch.pin,
                ch.label,
                ch.describe(),
                PULSE_HIGH_SECS,
            )
            # Start from a known-low state.
            await self.drive_do(ch, False)

            # The schedule lives in a persisted tag (absolute epoch) so a
            # sleep/wake cycle resumes the countdown instead of restarting it.
            next_epoch = self.get_tag(ch.epoch_tag)
            if next_epoch is None:
                # First run ever: fire on the first loop so the wiring from the
                # output to the voltage input can be confirmed straight away.
                log.info("DO%d: no saved schedule - firing an initial pulse now.", ch.pin)
                await self.schedule(ch, time.time())
            else:
                log.info(
                    "DO%d: resuming saved schedule - next pulse at %s (in %s)",
                    ch.pin,
                    iso(next_epoch),
                    human_duration(next_epoch - time.time()),
                )

    async def main_loop(self):
        now = time.time()
        for ch in CHANNELS:
            next_epoch = self.get_tag(ch.epoch_tag)
            if next_epoch is None:
                # Shouldn't happen after setup, but never sit idle unscheduled.
                await self.schedule(ch, now)
                continue

            if now >= next_epoch:
                await self.pulse(ch)
                await self.schedule(ch, time.time() + ch.next_interval())
            elif now - ch.last_report >= REPORT_INTERVAL_SECS:
                ch.last_report = now
                log.info(
                    "DO%d (%s): next pulse in %s (at %s)",
                    ch.pin,
                    ch.label,
                    human_duration(next_epoch - now),
                    iso(next_epoch),
                )

    async def schedule(self, ch: PulseChannel, epoch: float):
        await self.set_tag(ch.epoch_tag, epoch)
        await self.set_tag(ch.time_tag, iso(epoch))
        log.info("DO%d (%s): next pulse scheduled for %s", ch.pin, ch.label, iso(epoch))

    async def pulse(self, ch: PulseChannel):
        await self.drive_do(ch, True)
        await asyncio.sleep(PULSE_HIGH_SECS)
        await self.drive_do(ch, False)
        log.info("DO%d (%s): pulse fired", ch.pin, ch.label)

    async def drive_do(self, ch: PulseChannel, value: bool):
        """Set a digital output and record the change so it can be cross-checked."""
        await self.set_do(ch.pin, value)
        await self.record_do(ch, value)

    async def record_do(self, ch: PulseChannel, value: bool):
        now = time.time()
        entry = {
            "do": ch.pin,
            "label": ch.label,
            "value": bool(value),
            "timestamp": iso(now),
        }
        log.info("Recording DO%d (%s) = %s to channel '%s'", ch.pin, ch.label, bool(value), LOG_CHANNEL)
        try:
            await self.create_message(LOG_CHANNEL, entry)
        except Exception as e:
            # A logging failure must never drop a pulse.
            log.warning("DO%d: failed to record set_do to channel '%s': %s", ch.pin, LOG_CHANNEL, e)


def main():
    """Run the pulse output application."""
    run_app(PulseOutputApp())


if __name__ == "__main__":
    main()
