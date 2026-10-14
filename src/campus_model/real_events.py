"""실제 세션 위치 기록 → 맞춤기 입력 사건열(EPSG:5186). 출력은 저장소 밖(임시 폴더)에만 쓴다. 원시 자료를 커밋하지 말 것.

사용: python -m campus_model.real_events <s_locations.json> <출력.json>
"""
import json
import sys
from datetime import datetime
from pathlib import Path

from .geo import lonlat_to_5186


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    if Path.cwd().resolve() in dst.resolve().parents:
        raise SystemExit("출력은 저장소 밖에 둔다")
    fixes = sorted(json.loads(src.read_text(encoding="utf-8")), key=lambda f: f["timestamp"])
    t0 = datetime.fromisoformat(fixes[0]["timestamp"].replace("Z", "+00:00")).timestamp()
    ev = []
    for f in fixes:
        x, y = lonlat_to_5186(f["longitude"], f["latitude"])
        t = datetime.fromisoformat(f["timestamp"].replace("Z", "+00:00")).timestamp() - t0
        ev.append({"type": "fix", "t": round(t, 3), "x": x, "y": y, "acc": f["horizontalAccuracy"],
                   "speed": f["speed"], "course": f["course"]})
    dst.write_text(json.dumps(ev), encoding="utf-8")
    print(len(ev), "fixes ->", dst)


if __name__ == "__main__":
    main()
