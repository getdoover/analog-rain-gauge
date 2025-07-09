import asyncio
import logging
import os

import aiohttp

from pydoover.docker import Application, run_app
from pydoover.config import Schema


PULSE_INTERVALS = {
    "no_rain": 0,
    "light_rain": 360,  # 2mm per hour
    "moderate_rain": 144,  # 5mm per hour
    "heavy_rain": 36,  # 20mm per hour
    "very_heavy_rain": 14.4,  # 50mm per hour
}

DEFAULT_INTENSITY = "light_rain"

log = logging.getLogger()


class PlatformInterfaceSim:
    def __init__(self, endpoint: str = "http://localhost:8080"):
        self.endpoint = endpoint
        self.session = aiohttp.ClientSession()

    async def request(self, method, path, data: dict):
        return await self.session.request(method, self.endpoint + path, json=data)

    async def set_di(self, di, enabled: bool):
        await self.request("POST", f"/di/{di}", {"value": enabled})


class AnalogRainGaugeSimulator(Application):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.platform_sim: PlatformInterfaceSim = None
        self.pulse_pin = int(os.environ.get("PULSE_PIN", 0))

        self.pulse_interval: float = 0.0
        self.last_intensity: str = ""

        self.pulse_task = None

    async def setup(self):
        log.info("Setting up Analog Rain Gauge Simulator")
        self.platform_sim = PlatformInterfaceSim()
        self.update_pulse_interval(DEFAULT_INTENSITY)

    async def main_loop(self):
        intensity = self.get_tag("rain_intensity")
        if intensity != self.last_intensity:
            log.info(f"Rain intensity changed to {intensity}, updating pulse interval.")
            self.update_pulse_interval(intensity)
            self.last_intensity = intensity

    def update_pulse_interval(self, intensity):
        try:
            self.pulse_interval = PULSE_INTERVALS[intensity]
        except KeyError:
            log.info("Unknown rain intensity, using default pulse interval.")
            self.pulse_interval = PULSE_INTERVALS[DEFAULT_INTENSITY]

        if self.pulse_task:
            self.pulse_task.cancel()
        self.pulse_task = asyncio.create_task(self.do_pulses())

    async def do_pulses(self):
        await self.platform_sim.set_di(self.pulse_pin, True)
        while True:
            log.info(f"Waiting {self.pulse_interval} seconds before next pulse")
            await asyncio.sleep(self.pulse_interval)

            await self.platform_sim.set_di(self.pulse_pin, False)
            await asyncio.sleep(0.1)
            await self.platform_sim.set_di(self.pulse_pin, True)



def main():
    """Run the sample simulator application."""
    c = Schema()
    setattr(c, "_Schema__element_map", {})
    run_app(AnalogRainGaugeSimulator(config=c))

if __name__ == "__main__":
    main()
