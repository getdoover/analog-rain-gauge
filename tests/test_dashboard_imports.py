"""
Basic tests for the rainfall dashboard application.

Ensures the dashboard package is importable and its config/UI are valid.
"""


def test_import_app():
    from analog_rain_gauge_dashboard.application import AnalogRainGaugeDashboardApp

    assert AnalogRainGaugeDashboardApp
    assert AnalogRainGaugeDashboardApp.config_cls is not None
    assert AnalogRainGaugeDashboardApp.ui_cls is not None


def test_handler_importable():
    from analog_rain_gauge_dashboard import handler

    assert callable(handler)


def test_config():
    from analog_rain_gauge_dashboard.app_config import AnalogRainGaugeDashboardConfig

    schema = AnalogRainGaugeDashboardConfig.to_schema()
    assert isinstance(schema, dict)
    # extended permissions + gauge_app_name + farm_name + position + ignore_groups
    assert len(schema["properties"]) > 0
    assert "gauge_app_name" in schema["properties"]


def test_ui():
    from analog_rain_gauge_dashboard.app_ui import AnalogRainGaugeDashboardUI
    from pydoover.ui import UI

    assert issubclass(AnalogRainGaugeDashboardUI, UI)
