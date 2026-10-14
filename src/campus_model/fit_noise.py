"""실제 iPhone 세션(C03) 위치 기록에서 잡음 분포만 뽑아 params/noise_stats.json 에 저장.

원시 위치는 저장소에 넣지 않는다. 입력 경로는 인자로 받고, 출력은 분위수·비율 같은 집계값뿐이다.
실내/바깥 구분은 점이 건물 외곽선 안에 있는지로 정한 추정치다(GPS 자체가 틀리므로 거칠다).
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np

from .geo import in_any_footprint, lonlat_to_5186, quantiles


def _t(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def main() -> None:
    src = Path(sys.argv[1])
    pkg = json.loads(Path("data/package.json").read_text(encoding="utf-8"))
    fps = [b["footprint"] for b in pkg["buildings"] if b.get("footprint")]
    fixes = sorted(json.loads(src.read_text(encoding="utf-8")), key=lambda f: f["timestamp"])

    t = np.array([_t(f["timestamp"]) for f in fixes])
    acc = np.array([f["horizontalAccuracy"] for f in fixes])
    xy = np.array([lonlat_to_5186(f["longitude"], f["latitude"]) for f in fixes])
    indoor = np.array([in_any_footprint(x, y, fps) for x, y in xy])
    speed_valid = np.array([f["speed"] >= 0 for f in fixes])
    course_valid = np.array([f["course"] >= 0 for f in fixes])

    dt = np.diff(t)
    jump = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    stale = jump < 1e-6
    # 걸음 수 기준 실제 거리(트래커 C03 노트: 1066 m) 대비 GPS 경로 길이
    out = {
        "source": "C03 iPhone 2026-10-13 (집계값만)",
        "n_fixes": int(len(fixes)),
        "duration_s": round(float(t[-1] - t[0]), 1),
        "indoor_rule": "fix 위치가 건물 외곽선 안(추정)",
        "indoor_ratio": round(float(indoor.mean()), 3),
        "accuracy": {
            "all": quantiles(acc),
            "indoor": quantiles(acc[indoor]),
            "outdoor": quantiles(acc[~indoor]),
        },
        "speed_valid_ratio": {"indoor": round(float(speed_valid[indoor].mean()), 3),
                               "outdoor": round(float(speed_valid[~indoor].mean()), 3) if (~indoor).any() else None},
        "course_valid_ratio": round(float(course_valid.mean()), 3),
        "fix_interval_s": quantiles(dt),
        "stale_repeat_ratio": round(float(stale.mean()), 3),
        "jump_m": quantiles(jump[~stale]),
        "jump_speed_mps": quantiles(jump[~stale] / np.maximum(dt[~stale], 0.5)),
        "jump_over_acc": quantiles(jump[~stale] / np.maximum(acc[1:][~stale], 1)),
        "gps_path_m": round(float(jump.sum()), 1),
        "pedometer_path_m_note": 1066,
    }
    Path("params").mkdir(exist_ok=True)
    Path("params/noise_stats.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False)[:1500])


if __name__ == "__main__":
    main()
