from pydoover.processor import run_app

from .application import AnalogRainGaugeDashboardApp


def handler(event, context):
    """Lambda handler entry point."""
    # Don't call AnalogRainGaugeDashboardConfig.clear_elements() here: the
    # element map is only built when the class is defined, so clearing it
    # leaves any element whose attribute differs from its config key (e.g.
    # `radar` / `bom_radar`) permanently unloaded.
    return run_app(
        AnalogRainGaugeDashboardApp(),
        event,
        context,
    )
