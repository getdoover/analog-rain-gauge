"""BOM radar images from the BOM FTP feed.

BOM publishes a transparent 512x512 PNG every 5 minutes for each radar site and
range (``IDRnnnX.T.yyyymmddhhmm.png``) and every 10 minutes for the national
mosaic (``IDR00004.T.yyyymmddhhmm.png``), keeping about the last two hours. We
store each new frame as a message attachment so the dashboard can play radar
back over longer windows than BOM keeps.

Each site image is a gnomonic projection centred on the radar; its geographic
corners come from ``radar_transparencies/coordinates/IDRnnnX.map``. The national
mosaic has no published georeference; the widget carries its projection,
fitted against the site images (see ``dashboard-widget/src/lib/radar.ts``).
"""

import ftplib
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone

NATIONAL_PRODUCT = "IDR00004"
RADAR_DIR = "/anon/gen/radar"
COORDINATES_DIR = "/anon/gen/radar_transparencies/coordinates"

# Range choice -> the digit BOM appends to the radar ID. The range is the
# image's radius, so the 128 km image is 256 km across.
RANGES = {"512 km": 1, "256 km": 2, "128 km": 3, "64 km": 4}

# Radar ID -> (name, latitude, longitude), from BOM's radar site list
# (ftp://ftp.bom.gov.au/anon/home/adfd/spatial/IDR00007.dbf). Sites only on the
# Registered User feed are kept: nearest-site picks only from what the feed lists.
SITES: dict[int, tuple[str, float, float]] = {
    1: ("Melbourne (Broadmeadows)", -37.6899, 144.9472),
    2: ("Melbourne (Laverton)", -37.8552, 144.7554),
    3: ("Wollongong (Appin)", -34.2624, 150.8751),
    4: ("Newcastle", -32.7298, 152.0254),
    6: ("Geraldton", -28.8047, 114.6974),
    7: ("Wyndham", -15.4517, 128.1209),
    8: ("Gympie (Mount Kanigan)", -25.9573, 152.5769),
    10: ("Darwin Airport", -12.4246, 130.8921),
    14: ("Mount Gambier", -37.7477, 140.7746),
    16: ("Port Hedland", -20.3718, 118.6317),
    17: ("Broome", -17.9483, 122.2353),
    19: ("Cairns", -16.8182, 145.6630),
    22: ("Mackay", -21.1172, 149.2173),
    23: ("Gladstone", -23.8551, 151.2625),
    24: ("Bowen", -19.8858, 148.0757),
    25: ("Alice Springs", -23.7950, 133.8889),
    26: ("Perth Airport", -31.9273, 115.9756),
    27: ("Woomera", -31.1558, 136.8044),
    28: ("Grafton", -29.6207, 152.9633),
    29: ("Learmonth", -22.1032, 113.9997),
    31: ("Albany", -34.9418, 117.8163),
    32: ("Esperance", -33.8302, 121.8917),
    33: ("Ceduna", -32.1298, 133.6964),
    36: ("Mornington Island", -16.6641, 139.1812),
    37: ("Hobart Airport", -42.8374, 147.5009),
    38: ("Newdegate", -33.0969, 119.0088),
    39: ("Halls Creek", -18.2289, 127.6628),
    40: ("Canberra (Captains Flat)", -35.6614, 149.5122),
    41: ("Willis Island", -16.2874, 149.9646),
    42: ("Katherine (Tindal)", -14.5109, 132.4470),
    44: ("Giles", -25.0332, 128.3017),
    46: ("Adelaide (Sellicks Hill)", -35.3295, 138.5025),
    48: ("Kalgoorlie", -30.7842, 121.4548),
    49: ("Yarrawonga", -36.0296, 146.0228),
    50: ("Brisbane (Marburg)", -27.6063, 152.5400),
    52: ("NW Tasmania (West Takone)", -41.1792, 145.5800),
    53: ("Moree", -29.4903, 149.8462),
    55: ("Wagga Wagga", -35.1581, 147.4563),
    56: ("Longreach", -23.4398, 144.2823),
    58: ("South Doodlakine", -31.7778, 117.9528),
    62: ("Norfolk Island", -29.0383, 167.9414),
    63: ("Darwin (Berrimah)", -12.4559, 130.9266),
    64: ("Adelaide (Buckland Park)", -34.6170, 138.4688),
    66: ("Brisbane (Mt Stapylton)", -27.7177, 153.2400),
    67: ("Warrego", -26.4402, 147.3491),
    68: ("Bairnsdale", -37.8875, 147.5755),
    69: ("Namoi (Blackjack Mountain)", -31.0242, 150.1920),
    70: ("Perth (Serpentine)", -32.3918, 115.8670),
    71: ("Sydney (Terrey Hills)", -33.7008, 151.2095),
    72: ("Emerald", -23.5496, 148.2392),
    74: ("Greenvale", -18.9977, 144.9959),
    75: ("Mount Isa", -20.7112, 139.5553),
    76: ("Hobart (Mt Koonya)", -43.1126, 147.8052),
    77: ("Warruwi", -11.6485, 133.3800),
    78: ("Weipa", -12.6664, 141.9246),
    79: ("Watheroo", -30.3602, 116.2897),
    93: ("Brewarrina", -29.9708, 146.8136),
    94: ("Hillston", -33.5522, 145.5286),
    95: ("Rainbow (Wimmera)", -35.9976, 142.0133),
    96: ("Yeoval", -32.7445, 148.7081),
    97: ("Mildura", -34.2871, 141.5982),
    98: ("Taroom", -25.6962, 149.8982),
    106: ("Townsville", -19.4198, 146.5510),
    107: ("Richmond", -20.7518, 143.1414),
    108: ("Toowoomba", -27.2741, 151.9930),
    111: ("Karratha", -20.9924, 116.8758),
    112: ("Gove", -12.2690, 136.8204),
    114: ("Carnarvon", -24.8883, 113.6694),
}

FRAME_RE = re.compile(r"^(IDR[0-9A-Z]+)\.T\.(\d{12})\.png$")


@dataclass(frozen=True)
class Frame:
    product: str
    filename: str
    time_ms: int


def product_code(radar_id: int, range_digit: int) -> str:
    return f"IDR{radar_id:02d}{range_digit}"


def parse_frames(names: list[str]) -> dict[str, list[Frame]]:
    """Group a radar directory listing into {product: frames, oldest first}."""
    out: dict[str, list[Frame]] = {}
    for name in names:
        m = FRAME_RE.match(name.rsplit("/", 1)[-1])
        if not m:
            continue
        product, stamp = m.groups()
        t = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        out.setdefault(product, []).append(Frame(product, m.group(0), int(t.timestamp() * 1000)))
    for frames in out.values():
        frames.sort(key=lambda f: f.time_ms)
    return out


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def nearest_site(lat: float, lon: float, range_digit: int, available: set[str]) -> int | None:
    """The closest radar that publishes the given range on this feed."""
    best, best_km = None, math.inf
    for rid, (_, slat, slon) in SITES.items():
        if product_code(rid, range_digit) not in available:
            continue
        km = distance_km(lat, lon, slat, slon)
        if km < best_km:
            best, best_km = rid, km
    return best


def centroid(points: list[tuple[float, float]]) -> tuple[float, float] | None:
    if not points:
        return None
    return (
        sum(p[0] for p in points) / len(points),
        sum(p[1] for p in points) / len(points),
    )


def parse_map(text: str) -> dict:
    """Parse an ``IDRnnnX.map`` file into its centre and four corners.

    Corners are numbered 0 = bottom-left, 1 = top-left, 2 = top-right,
    3 = bottom-right of the image.
    """
    values = dict(re.findall(r"^\s*(\w+)\s*=\s*(\S+)\s*$", text, re.MULTILINE))
    out = {"projection": values.get("projection", "Gnomonic")}
    out["center"] = [float(values["center_longitude"]), float(values["center_latitude"])]
    out["corners"] = [[float(values[f"lon{i}"]), float(values[f"lat{i}"])] for i in range(4)]
    return out


class RadarFtp:
    """A short-lived FTP session against BOM's radar directories."""

    def __init__(self, host: str, username: str, password: str, timeout: float = 60):
        self.ftp = ftplib.FTP(timeout=timeout)
        self.ftp.connect(host, 21)
        self.ftp.login(username or "anonymous", password)

    def list(self, directory: str) -> list[str]:
        return [n.rsplit("/", 1)[-1] for n in self.ftp.nlst(directory)]

    def read(self, path: str) -> bytes:
        chunks: list[bytes] = []
        self.ftp.retrbinary(f"RETR {path}", chunks.append)
        return b"".join(chunks)

    def close(self) -> None:
        try:
            self.ftp.quit()
        except Exception:
            self.ftp.close()
