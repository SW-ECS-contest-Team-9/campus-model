"""실제 세션 위치 기록 → 맞춤기 입력 사건열(EPSG:5186). 출력은 저장소 밖(임시 폴더)에만 쓴다. 원시 자료를 커밋하지 말 것.

사용:
  python -m campus_model.real_events <s_locations.json> <출력.json> [s_fused-positions.json]
  python -m campus_model.real_events --dir <세션폴더(<id>.json: session/locations/fused)> <출력폴더>

fused 가 있으면(서버 융합 결과, 1초 간격) 대용 센서를 만든다(실측 센서 아님, 표시해 둘 것):
- 기압 대용: relativeAltitude → baro 사건
- 걸음 대용: 융합 위치(localX/Y)의 초당 변위 → 0.7 m 마다 step 사건(방향 = 변위 방향)
"""
import json
import math
import sys
from datetime import datetime
from pathlib import Path

from .geo import lonlat_to_5186

GEOID_N = 23.377


def _ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def to_events(locations, fused=None, stride=0.7):
    fixes = sorted(locations, key=lambda f: f["timestamp"])
    t0 = min([_ts(fixes[0]["timestamp"])] + ([_ts(fused[0]["timestamp"])] if fused else []))
    ev = []
    for f in fixes:
        x, y = lonlat_to_5186(f["longitude"], f["latitude"])
        ev.append({"type": "fix", "t": round(_ts(f["timestamp"]) - t0, 3), "x": x, "y": y,
                   "acc": f.get("horizontalAccuracy") or 30, "speed": f.get("speed", -1) if f.get("speed") is not None else -1,
                   "course": f.get("course", -1) if f.get("course") is not None else -1})
        if f.get("ellipsoidalAltitude") is not None and f.get("verticalAccuracy") is not None and f["verticalAccuracy"] > 0:
            # 지도 z 는 정표고. 캠퍼스 지오이드고(KNGeoid18) 23.377 m (campus-tracker geo/campus-frame.ts)
            ev[-1]["alt"] = round(f["ellipsoidalAltitude"] - GEOID_N, 2)
            ev[-1]["vacc"] = f["verticalAccuracy"]
    if fused:
        fused = sorted(fused, key=lambda f: f["timestamp"])
        acc_d, prev = 0.0, None
        for f in fused:
            t = _ts(f["timestamp"]) - t0
            if f.get("relativeAltitude") is not None:
                ev.append({"type": "baro", "t": round(t - 0.05, 3), "h": f["relativeAltitude"]})
            if prev is not None and f.get("localX") is not None and prev.get("localX") is not None:
                dx, dy = f["localX"] - prev["localX"], f["localY"] - prev["localY"]
                d = math.hypot(dx, dy)
                if d < 5:  # 융합 재기준(점프)은 걸음으로 치지 않음
                    acc_d += d
                    hdg = math.degrees(math.atan2(dx, dy)) % 360
                    k = 0
                    while acc_d >= stride:
                        acc_d -= stride
                        k += 1
                        ev.append({"type": "step", "t": round(t - 0.5 + 0.1 * k, 3), "heading": round(hdg, 1)})
            prev = f
    ev.sort(key=lambda e: (e["t"], e["type"] != "baro"))
    return ev


def _guard(dst: Path):
    if Path.cwd().resolve() in dst.resolve().parents:
        raise SystemExit("출력은 저장소 밖에 둔다")


def main():
    if sys.argv[1] == "--dir":
        src, dst = Path(sys.argv[2]), Path(sys.argv[3])
        _guard(dst)
        dst.mkdir(parents=True, exist_ok=True)
        files = sorted(src.glob("*.json")) if src.exists() else []
        for p in files:
            d = json.loads(p.read_text(encoding="utf-8"))
            if not d.get("locations"):
                continue
            ev = to_events(d["locations"], d.get("fused"))
            (dst / p.name).write_text(json.dumps(ev), encoding="utf-8")
        print(len(files), "sessions ->", dst)
        return
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    _guard(dst)
    fused = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8")) if len(sys.argv) > 3 else None
    ev = to_events(json.loads(src.read_text(encoding="utf-8")), fused)
    dst.write_text(json.dumps(ev), encoding="utf-8")
    print(sum(e["type"] == "fix" for e in ev), "fixes,", sum(e["type"] == "step" for e in ev), "proxy steps,",
          sum(e["type"] == "baro" for e in ev), "proxy baro ->", dst)


if __name__ == "__main__":
    main()
