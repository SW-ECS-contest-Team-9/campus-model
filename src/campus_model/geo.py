"""좌표·도형 도우미."""
import numpy as np
from pyproj import Transformer

_T = Transformer.from_crs(4326, 5186, always_xy=True)


def lonlat_to_5186(lon, lat):
    return _T.transform(lon, lat)


def point_in_poly(x: float, y: float, poly) -> bool:
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_any_footprint(x: float, y: float, footprints) -> bool:
    return any(point_in_poly(x, y, fp) for fp in footprints)


def quantiles(a, qs=(0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1)):
    a = np.asarray(a, dtype=float)
    return {"q": list(qs), "v": [round(float(v), 3) for v in np.quantile(a, qs)]} if len(a) else None
