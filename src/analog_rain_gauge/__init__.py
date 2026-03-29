from pydoover.docker import run_app

from .application import AnalogRainGaugeApplication


def main():
    """
    Run the application.
    """
    run_app(AnalogRainGaugeApplication())
