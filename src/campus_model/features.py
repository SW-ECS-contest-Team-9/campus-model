"""GPS 믿음 모델 입력 특징. ts/src/features.ts 와 같은 계산이어야 한다(동치 시험: ts/test/features.test.ts)."""
import math

from .geo import in_any_footprint

FEATURE_NAMES = [
    "log_acc", "speed_valid", "course_valid", "log_dt", "log_jump_resid",
    "log_spread", "inside_fp", "baro_change_10s", "steps_10s", "stale", "is_android",
    # 2차 추가(앞 11개만 쓰는 1차 모델과 호환): 걸음 추측항법 대비 혁신(최근 10개 평균), 최근 30초 GPS 빈 비율(위성 정보 없는 실내 단서)
    "log_pdr_innov", "gap_ratio_30s",
]
STRIDE_M = 0.7


class FeatureState:
    def __init__(self, footprints, platform="ios"):
        self.footprints = footprints
        self.android = 1.0 if platform == "android" else 0.0
        self.fixes = []  # (t, x, y)
        self.steps = []  # t
        self.baro = []  # (t, h)
        self.steps_since_fix = 0
        self.dr = None  # 걸음 추측항법 위치(GPS 로 조금씩 당김)
        self.innov = []
        self.fix_ts = []

    def step(self, t, heading=None):
        if heading is not None and self.dr is not None:
            h = math.radians(heading)
            self.dr = (self.dr[0] + STRIDE_M * math.sin(h), self.dr[1] + STRIDE_M * math.cos(h))
        self.steps.append(t)
        self.steps_since_fix += 1
        while self.steps and self.steps[0] < t - 10:
            self.steps.pop(0)

    def baro_sample(self, t, h):
        self.baro.append((t, h))
        while len(self.baro) > 1 and self.baro[1][0] <= t - 10:
            self.baro.pop(0)

    def fix(self, t, x, y, acc, speed, course):
        if self.fixes:
            pt, px, py = self.fixes[-1]
            dt = min(t - pt, 60.0)
            jump = math.hypot(x - px, y - py)
        else:
            dt, jump = 60.0, 0.0
        resid = max(0.0, jump - self.steps_since_fix * STRIDE_M)
        self.fixes.append((t, x, y))
        if len(self.fixes) > 5:
            self.fixes.pop(0)
        mx = sum(f[1] for f in self.fixes) / len(self.fixes)
        my = sum(f[2] for f in self.fixes) / len(self.fixes)
        spread = math.sqrt(sum((f[1] - mx) ** 2 + (f[2] - my) ** 2 for f in self.fixes) / len(self.fixes))
        steps10 = sum(1 for s in self.steps if s > t - 10)
        bchg = abs(self.baro[-1][1] - self.baro[0][1]) if self.baro else 0.0
        if self.dr is None:
            self.dr = (x, y)
        inn = math.hypot(x - self.dr[0], y - self.dr[1])
        self.dr = (self.dr[0] + 0.2 * (x - self.dr[0]), self.dr[1] + 0.2 * (y - self.dr[1]))
        self.innov.append(inn)
        if len(self.innov) > 10:
            self.innov.pop(0)
        self.fix_ts.append(t)
        while self.fix_ts and self.fix_ts[0] <= t - 30:
            self.fix_ts.pop(0)
        f = [
            math.log(max(acc, 1.0)),
            1.0 if speed >= 0 else 0.0,
            1.0 if course >= 0 else 0.0,
            math.log1p(dt),
            math.log1p(resid),
            math.log1p(spread),
            1.0 if in_any_footprint(x, y, self.footprints) else 0.0,
            min(bchg, 20.0),
            float(min(steps10, 30)),
            1.0 if (jump < 0.01 and len(self.fixes) > 1) else 0.0,
            self.android,
            math.log1p(sum(self.innov) / len(self.innov)),
            max(0.0, 1.0 - len(self.fix_ts) / 30.0),
        ]
        self.steps_since_fix = 0
        return f


def write_parity_fixture(path="ts/test/fixtures/features_parity.json"):
    """TS 동치 시험용: 합성 시험셋 첫 경로로 특징을 계산해 저장."""
    import json
    from pathlib import Path

    from .graph import load
    g = load()
    r = json.loads(Path("data/synth/test.json").read_text(encoding="utf-8"))["routes"][0]
    st = FeatureState(g.footprints, r["platform"])
    feats = []
    for e in r["events"]:
        if e["type"] == "step":
            st.step(e["t"], e["heading"])
        elif e["type"] == "baro":
            st.baro_sample(e["t"], e["h"])
        else:
            feats.append(st.fix(e["t"], e["x"], e["y"], e["acc"], e["speed"], e["course"]))
    Path(path).write_text(json.dumps({"footprints": g.footprints, "platform": r["platform"], "events": r["events"], "features": feats}), encoding="utf-8")


if __name__ == "__main__":
    write_parity_fixture()
