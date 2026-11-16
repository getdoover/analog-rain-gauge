from pathlib import Path

from pydoover import config
from pydoover.processor import ExtendedPermissionsConfig, ScheduleConfig

from .radar import COORDINATES_DIR, RADAR_DIR, RANGES

# Objects only load their fields' defaults from the Object's own default, so
# the defaults are spelled out here as well.
RADAR_DEFAULTS = {
    "enabled": True,
    "site": "",
    "range": "128 km",
    "national": True,
    "keep_days": 7.0,
    "host": "ftp.bom.gov.au",
    "username": "anonymous",
    "password": "",
    "directory": RADAR_DIR,
    "coordinates_directory": COORDINATES_DIR,
}


class RadarSettings(config.Object):
    enabled = config.Boolean(
        "Show Radar",
        name="enabled",
        default=RADAR_DEFAULTS["enabled"],
        description="Record BOM radar images and show them over the map.",
    )
    site = config.String(
        "Radar Site",
        name="site",
        default=RADAR_DEFAULTS["site"],
        description="BOM radar ID, e.g. 53 for Moree. Leave blank to use the radar nearest the gauges.",
    )
    range = config.Enum(
        "Radar Range",
        name="range",
        choices=list(RANGES),
        default=RADAR_DEFAULTS["range"],
        description="Radius of the local radar image. Not every radar publishes 64 km.",
    )
    national = config.Boolean(
        "National Mosaic",
        name="national",
        default=RADAR_DEFAULTS["national"],
        description="Also record BOM's national radar mosaic, shown when the map is zoomed out.",
    )
    keep_days = config.Number(
        "Keep Images (days)",
        name="keep_days",
        default=RADAR_DEFAULTS["keep_days"],
        minimum=1.0,
        description="Radar images older than this are deleted.",
        advanced=True,
    )
    host = config.String("FTP Host", name="host", default=RADAR_DEFAULTS["host"], advanced=True)
    username = config.String(
        "FTP Username", name="username", default=RADAR_DEFAULTS["username"], advanced=True
    )
    password = config.String(
        "FTP Password",
        name="password",
        default=RADAR_DEFAULTS["password"],
        description="Leave blank for BOM's anonymous feed. Set for a Registered User feed.",
        advanced=True,
    )
    directory = config.String(
        "Radar Directory", name="directory", default=RADAR_DEFAULTS["directory"], advanced=True
    )
    coordinates_directory = config.String(
        "Coordinates Directory",
        name="coordinates_directory",
        default=RADAR_DEFAULTS["coordinates_directory"],
        advanced=True,
    )


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

    radar = RadarSettings(
        "BOM Radar",
        default=RADAR_DEFAULTS,
        description="BOM rain radar over the map. Defaults use BOM's public feed.",
    )

    # Fetches new radar images. BOM publishes every 5 minutes and keeps ~2 hours,
    # so any rate up to an hour or so loses nothing.
    schedule = ScheduleConfig(
        allowed_modes=["rate", "cron"], default="rate(10 minutes)", advanced=True
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
