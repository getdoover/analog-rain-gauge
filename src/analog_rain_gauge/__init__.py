from pydoover.docker import run_app

from .application import AnalogRainGaugeApplication
from .app_config import AnalogRainGaugeConfig

def main():
    """
    Run the application.
    """
    run_app(AnalogRainGaugeApplication(config=AnalogRainGaugeConfig()))
