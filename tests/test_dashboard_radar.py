from analog_rain_gauge_dashboard import radar

MAP_TEXT = """IDR533.map
53 Moree (128 km)
projection = Gnomonic
center_longitude =     149.85001
center_latitude  =     -29.50000
lon0 =     148.51648
lat0 =     -30.64030
lon1 =     148.54645
lat1 =     -28.33886
lon2 =     151.16147
lat2 =     -28.33879
lon3 =     151.19162
lat3 =     -30.64022
"""


def test_parse_frames_groups_and_sorts():
    frames = radar.parse_frames(
        [
            "IDR533.T.202611160109.png",
            "IDR533.T.202611160104.png",
            "IDR533.gif",
            "IDR00004.T.202611160100.png",
            "IDR1063.T.202611160104.png",
            "/anon/gen/radar/IDR532.T.202611160104.png",
        ]
    )
    assert set(frames) == {"IDR533", "IDR00004", "IDR1063", "IDR532"}
    assert [f.filename for f in frames["IDR533"]] == [
        "IDR533.T.202611160104.png",
        "IDR533.T.202611160109.png",
    ]
    # 2026-11-16 01:04 UTC
    assert frames["IDR533"][0].time_ms == 1794791040000


def test_product_code_pads_two_digit_ids():
    assert radar.product_code(2, 3) == "IDR023"
    assert radar.product_code(53, 3) == "IDR533"
    assert radar.product_code(106, 4) == "IDR1064"


def test_nearest_site_only_picks_published_products():
    moree_farm = (-29.45, 149.6)
    available = {"IDR533", "IDR532", "IDR693", "IDR694"}
    assert radar.nearest_site(*moree_farm, 3, available) == 53
    # Moree has no 64 km product, so the next nearest that does.
    assert radar.nearest_site(*moree_farm, 4, available) == 69
    assert radar.nearest_site(*moree_farm, 1, available) is None


def test_parse_map():
    m = radar.parse_map(MAP_TEXT)
    assert m["projection"] == "Gnomonic"
    assert m["center"] == [149.85001, -29.5]
    assert m["corners"][1] == [148.54645, -28.33886]
    assert len(m["corners"]) == 4


def test_centroid():
    assert radar.centroid([]) is None
    assert radar.centroid([(-29.0, 149.0), (-30.0, 150.0)]) == (-29.5, 149.5)


DEPLOYED = {
    "bom_radar": {
        "host": "ftp.bom.gov.au",
        "site": "",
        "range": "128 km",
        "enabled": True,
        "national": True,
        "password": "",
        "username": "anonymous",
        "directory": "/anon/gen/radar",
        "keep_days": 7,
        "coordinates_directory": "/anon/gen/radar_transparencies/coordinates",
    },
    "farm_name": "",
    "gauge_app_name": "analog_rain_gauge_1",
    "ignored_groups": ["127188186160990990"],
    "dv_app_position": 100,
    "dv_proc_schedules": "rate(10 minutes)",
    "dv_proc_extended_permissions": {"groups": [], "devices": [], "apps_installed": ["1"]},
}


def test_radar_config_loads_across_warm_invocations():
    from analog_rain_gauge_dashboard.app_config import AnalogRainGaugeDashboardConfig

    # A warm Lambda builds a fresh config per invocation.
    for _ in range(2):
        cfg = AnalogRainGaugeDashboardConfig()
        cfg._inject_deployment_config(DEPLOYED)
        assert cfg.radar.enabled.value is True
        assert cfg.radar.range.value == "128 km"
        assert float(cfg.radar.keep_days.value) == 7
        assert [g.value for g in cfg.ignore_groups.value] == ["127188186160990990"]


def test_parse_site_ids():
    assert radar.parse_site_ids("53, 69 IDR93") == [53, 69, 93]
    assert radar.parse_site_ids("53;53") == [53]
    assert radar.parse_site_ids("") == []


def test_group_by_slot_bundles_radars_in_the_same_5_minutes():
    frames = radar.parse_frames(
        [
            "IDR533.T.202611160104.png",
            "IDR693.T.202611160101.png",
            "IDR533.T.202611160109.png",
            "IDR00004.T.202611160100.png",
        ]
    )
    items = [("local", f) for p in ("IDR533", "IDR693") for f in frames[p]]
    items += [("national", f) for f in frames["IDR00004"]]
    slots = radar.group_by_slot(items)
    first, second = list(slots)
    assert second - first == radar.SLOT_MS
    assert sorted(f.product for _, f in slots[first]) == ["IDR00004", "IDR533", "IDR693"]
    assert [f.filename for _, f in slots[second]] == ["IDR533.T.202611160109.png"]
