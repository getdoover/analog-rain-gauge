"""
Basic tests for an application.

This ensures all modules are importable and that the config is valid.
"""

def test_import_app():
    from analog_rain_gauge.application import AnalogRainGaugeApplication
    assert AnalogRainGaugeApplication

def test_config():
    from analog_rain_gauge.app_config import AnalogRainGaugeConfig

    config = AnalogRainGaugeConfig()
    assert isinstance(config.to_dict(), dict)

def test_ui():
    from analog_rain_gauge.app_ui import AnalogRainGaugeUI
    assert AnalogRainGaugeUI
