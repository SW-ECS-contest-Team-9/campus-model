"""GPS 믿음 모델 입력 특징. ts/src/features.ts 와 같은 계산이어야 한다(동치 시험: ts/test/features.test.ts)."""
import math

from .geo import in_any_footprint

FEATURE_NAMES = [
    "log_acc", "speed_valid", "course_valid", "log_dt", "log_jump_resid",
    "log_spread", "inside_fp", "baro_change_10s", "steps_10s", "stale", "is_android",
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

    def step(self, t):
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
        ]
        self.steps_since_fix = 0
        return f
