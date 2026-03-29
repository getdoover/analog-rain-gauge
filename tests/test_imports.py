"""
Basic tests for an application.

This ensures all modules are importable and that the config is valid.
"""


def test_import_app():
    from analog_rain_gauge.application import AnalogRainGaugeApplication

    assert AnalogRainGaugeApplication
    assert AnalogRainGaugeApplication.config_cls is not None
    assert AnalogRainGaugeApplication.tags_cls is not None
    assert AnalogRainGaugeApplication.ui_cls is not None


def test_config():
    from analog_rain_gauge.app_config import AnalogRainGaugeConfig

    schema = AnalogRainGaugeConfig.to_schema()
    assert isinstance(schema, dict)
    assert len(schema["properties"]) > 0


def test_tags():
    from analog_rain_gauge.app_tags import AnalogRainGaugeTags

    assert AnalogRainGaugeTags


def test_ui():
    from analog_rain_gauge.app_ui import AnalogRainGaugeUI
    from pydoover.ui import UI

    assert issubclass(AnalogRainGaugeUI, UI)
