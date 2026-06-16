from pathlib import Path

from pydoover import config
from pydoover.processor import ExtendedPermissionsConfig


class AnalogRainGaugeDashboardConfig(config.Schema):
    # Grant the dashboard read access to the gauges it should aggregate. Set
    # "Apps Installed" to the Analog Rain Gauge app so every device running it
    # is automatically picked up; the platform populates a ``DEVICE_MAP`` in
    # this app's deployment config which the widget reads. The extra fields
    # ride along on each entry so the widget can locate each gauge's data
    # channel (``app_installs``) and place it on the map (``latitude`` /
    # ``longitude``) without any hardcoded device keys.
    extended_permissions = ExtendedPermissionsConfig(
        extra_fields=[
            "id",
            "display_name",
            "latitude",
            "longitude",
            "group__id",
            "type__name",
            # The gauge's data lives on the channel named after its Analog Rain
            # Gauge install. We carry every install's name + application_name so
            # the widget can find the one whose application_name matches
            # ``gauge_app_name`` and read its `daily` totals / `since_9am` tag.
            "app_installs__name",
            "app_installs__application_name",
            "solution_installs__display_name",
        ]
    )

    gauge_app_name = config.String(
        "Gauge App Name",
        default="analog_rain_gauge",
        description="The application name of the rain-gauge app to aggregate. The widget "
        "reads each device's matching install to find its data channel (rainfall "
        "totals + the live since-9am tag). Only change this if your gauges run a "
        "renamed fork of the Analog Rain Gauge app.",
    )

    farm_name = config.String(
        "Farm Name",
        default="",
        description="(Optional) Display name for the property shown in the dashboard header. "
        "Leave blank to use the dashboard's own name.",
    )

    position = config.ApplicationPosition()

    ignore_groups = config.GroupsConfig(
        "Ignored Groups",
        description="Any gauges in these groups will be hidden. "
        "Useful for testing or unallocated groups where you otherwise want to include all devices. "
        "Does not support hierarchical nesting - you must provide direct parent groups.",
    )


def export():
    AnalogRainGaugeDashboardConfig.export(
        Path(__file__).parents[2] / "doover_config.json",
        "analog_rain_gauge_dashboard",
    )
