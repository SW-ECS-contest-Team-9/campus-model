"""합성 동선 + iPhone 같은 센서 생성기.

사용: python -m campus_model.simulate [경로수=2000] [시드=7]
출력: data/synth/{train,val}.npz (특징·정답 오차), data/synth/test.json (TS 평가용 사건열 + 1 Hz 정답).
가정(실측 아님)은 ASSUME 에 모아 둔다. 잡음 분포는 params/noise_stats.json(C03 집계)에서 온다.
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

from .features import FEATURE_NAMES, FeatureState
from .geo import in_any_footprint
from .graph import edge_indoor, edge_points, load, shortest_path

ASSUME = {
    "outdoor_acc_scale": 0.4,       # 바깥 정확도 = C03 분포 × 0.4 (C03 은 거의 실내라 바깥 실측 없음, 추정)
    "walk_speed": (1.0, 1.6),
    "stairs_speed": (0.45, 0.7),    # 3차원 길이 기준
    "elevator_wait": (10, 40),
    "elevator_speed": 1.0,
    "pause_prob": 0.1, "pause_s": (5, 20),
    "stride": (0.62, 0.78), "stride_noise": 0.08, "stairs_stride_h": 0.3,
    "heading_noise_deg": 6.0, "heading_drift_deg_per_sqrt_s": 0.8,
    "baro_noise": 0.1, "baro_drift_per_sqrt_s": 0.02,
    "fix_p_outdoor": 0.95, "indoor_on_mean_s": 8.0, "indoor_off_mean_s": 5.0,
    "bias_rho": 0.995, "bias_std_frac": 0.55, "white_std_frac": 0.04,
    "indoor_err_mult": 1.5, "no_speed_err_mult": 1.2, "err_lognorm_sd": 0.35,
    "jump_p_outdoor": 0.01, "jump_p_indoor": 0.03, "jump_len_s": (3, 10),
    "speed_valid_outdoor": 0.85,
}


def inv_cdf(qd, u):
    return float(np.interp(u, qd["q"], qd["v"]))


def build_route(g, rng):
    """경로 다리 2~4개. 반환: 구간 목록 [(points, mode, edge_key|None, indoor)]."""
    nodes = [k for k in g.adj if g.nodes[k]["kind"] != "elevator_stop"]
    cur = nodes[rng.integers(len(nodes))]
    segs = []
    sig = [cur]
    for _ in range(rng.integers(2, 5)):
        areas = [a for a, ns in g.area_nodes.items() if cur in ns and len(ns) > 1]
        if areas and rng.random() < 0.35:
            a = areas[rng.integers(len(areas))]
            nxt = [n for n in g.area_nodes[a] if n != cur][rng.integers(len(g.area_nodes[a]) - 1)]
            p0, p1 = g.nodes[cur], g.nodes[nxt]
            segs.append(([(p0["x"], p0["y"], p0["z"]), (p1["x"], p1["y"], p1["z"])], "walk", None, False))
            cur = nxt
            sig.append(nxt)
            continue
        for _ in range(10):
            dst = nodes[rng.integers(len(nodes))]
            path = shortest_path(g, cur, dst)
            if path and len(path) >= 3:
                break
        else:
            continue
        for ek, fwd in path:
            kind = g.edges[ek]["kind"]
            mode = "stairs" if kind == "stairs" else "elevator" if kind == "elevator" else "walk"
            segs.append((edge_points(g, ek, fwd), mode, ek, edge_indoor(g, ek)))
        cur = dst
        sig.append(dst)
    return segs, sig


def truth_track(segs, rng):
    """1 Hz 정답 + 연속 이동 표본(0.1 s)."""
    A = ASSUME
    v_walk = rng.uniform(*A["walk_speed"])
    v_st = rng.uniform(*A["stairs_speed"])
    samples = []  # (t, x, y, z, edge, indoor, moving_h)
    t = 0.0
    dtc = 0.1
    for pts, mode, ek, indoor in segs:
        if mode == "elevator":
            x, y, z = pts[0]
            for _ in range(int(rng.uniform(*A["elevator_wait"]) / dtc)):
                samples.append((t, x, y, z, ek, indoor, False)); t += dtc
            v = A["elevator_speed"]
        else:
            v = v_st if mode == "stairs" else v_walk
        if mode == "walk" and rng.random() < A["pause_prob"]:
            x, y, z = pts[0]
            for _ in range(int(rng.uniform(*A["pause_s"]) / dtc)):
                samples.append((t, x, y, z, ek, indoor, False)); t += dtc
        for (x0, y0, z0), (x1, y1, z1) in zip(pts[:-1], pts[1:]):
            L = math.dist((x0, y0, z0), (x1, y1, z1))
            n = max(1, int(L / (v * dtc)))
            for i in range(n):
                f = i / n
                samples.append((t, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f, ek, indoor,
                                mode != "elevator"))
                t += dtc
    x, y, z = segs[-1][0][-1]
    samples.append((t, x, y, z, segs[-1][2], segs[-1][3], False))
    return samples


def sensors(samples, g, noise, rng):
    A = ASSUME
    ev = []
    # 걸음·방향
    stride = rng.uniform(*A["stride"])
    acc_h = 0.0
    next_step = stride
    drift = 0.0
    for (t0, x0, y0, z0, *_r0), (t1, x1, y1, z1, ek, ind, mv) in zip(samples[:-1], samples[1:]):
        drift += math.radians(A["heading_drift_deg_per_sqrt_s"]) * math.sqrt(t1 - t0) * rng.normal()
        d = math.hypot(x1 - x0, y1 - y0)
        if not mv or d < 1e-6:
            continue
        stairs = ek is not None and g.edges[ek]["kind"] == "stairs"
        acc_h += d
        thr = A["stairs_stride_h"] if stairs else next_step
        if acc_h >= thr:
            acc_h -= thr
            next_step = stride * (1 + A["stride_noise"] * rng.normal())
            hdg = math.degrees(math.atan2(x1 - x0, y1 - y0) + drift) + A["heading_noise_deg"] * rng.normal()
            ev.append({"t": round(t1, 2), "type": "step", "heading": round(hdg % 360, 1)})
    # 1 Hz: 기압, GPS, 정답
    truth = []
    bdrift = 0.0
    z0 = samples[0][3]
    bias = np.zeros(2)
    u = rng.normal()
    on = True
    jump_left, jump_vec = 0, np.zeros(2)
    hidden = rng.lognormal(0, A["err_lognorm_sd"])
    last_fix = None
    idx = 0
    T = samples[-1][0]
    for sec in range(int(T) + 1):
        while idx + 1 < len(samples) and samples[idx + 1][0] <= sec:
            idx += 1
        t, x, y, z, ek, ind, mv = samples[idx]
        # 이동 중 실제 속도(앞뒤 1 s)
        j = min(idx + 10, len(samples) - 1)
        spd = math.hypot(samples[j][1] - x, samples[j][2] - y) / max(samples[j][0] - t, 1e-6) if j > idx else 0.0
        truth.append({"t": sec, "x": round(x, 2), "y": round(y, 2), "z": round(z, 2), "indoor": ind, "edge": ek})
        bdrift += A["baro_drift_per_sqrt_s"] * rng.normal()
        ev.append({"t": sec, "type": "baro", "h": round(z - z0 + bdrift + A["baro_noise"] * rng.normal(), 2)})
        # GPS 가용성
        if ind:
            p_switch = 1 / A["indoor_on_mean_s"] if on else 1 / A["indoor_off_mean_s"]
            if rng.random() < p_switch:
                on = not on
            emit = on
        else:
            on = True
            emit = rng.random() < A["fix_p_outdoor"]
        # 정확도(상관된 분위)
        u = 0.9 * u + math.sqrt(1 - 0.81) * rng.normal()
        uq = 0.5 * (1 + math.erf(u / math.sqrt(2)))
        acc = inv_cdf(noise["accuracy"]["all"], uq)
        if not ind:
            acc *= A["outdoor_acc_scale"]
        speed_valid = rng.random() < (noise["speed_valid_ratio"]["indoor"] if ind else A["speed_valid_outdoor"])
        mult = hidden * (A["indoor_err_mult"] if ind else 1.0) * (1.0 if speed_valid else A["no_speed_err_mult"])
        sd_b = A["bias_std_frac"] * acc * mult
        bias = A["bias_rho"] * bias + math.sqrt(1 - A["bias_rho"] ** 2) * sd_b * rng.normal(size=2)
        white = A["white_std_frac"] * acc * mult * rng.standard_t(3, size=2)
        if jump_left > 0:
            jump_left -= 1
        elif rng.random() < (A["jump_p_indoor"] if ind else A["jump_p_outdoor"]):
            jump_left = int(rng.integers(*A["jump_len_s"]))
            ang = rng.uniform(0, 2 * math.pi)
            jump_vec = rng.uniform(1, 2.5) * acc * np.array([math.cos(ang), math.sin(ang)])
        err = bias + white + (jump_vec if jump_left > 0 else 0)
        if not emit:
            continue
        if last_fix is not None and rng.random() < noise["stale_repeat_ratio"]:
            fx, fy, facc = last_fix
        else:
            fx, fy, facc = x + err[0], y + err[1], acc
        last_fix = (fx, fy, facc)
        ev.append({"t": sec + 0.01, "type": "fix", "x": round(fx, 2), "y": round(fy, 2), "acc": round(facc, 1),
                   "speed": round(max(0.0, spd + 0.3 * rng.normal()), 2) if speed_valid else -1,
                   "course": 0 if speed_valid else -1,
                   "err": round(math.hypot(fx - x, fy - y), 2)})
    ev.sort(key=lambda e: (e["t"], e["type"] != "baro"))
    return ev, truth


def split_of(sig):
    h = int(hashlib.sha1((sig[0] + "|" + sig[-1]).encode()).hexdigest(), 16) % 10
    return "test" if h == 0 else "val" if h == 1 else "train"


def featurize(ev, footprints):
    st = FeatureState(footprints)
    X, y = [], []
    for e in ev:
        if e["type"] == "step":
            st.step(e["t"])
        elif e["type"] == "baro":
            st.baro_sample(e["t"], e["h"])
        else:
            X.append(st.fix(e["t"], e["x"], e["y"], e["acc"], e["speed"], e["course"]))
            y.append(math.log(max(e["err"], 0.5)))
    return X, y


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    g = load()
    noise = json.loads(Path("params/noise_stats.json").read_text(encoding="utf-8"))
    out = {"train": ([], []), "val": ([], [])}
    test = []
    stats = {"train": 0, "val": 0, "test": 0}
    for i in range(n):
        rng = np.random.default_rng([seed, i])
        segs, sig = build_route(g, rng)
        if not segs:
            continue
        samples = truth_track(segs, rng)
        ev, truth = sensors(samples, g, noise, rng)
        sp = split_of(sig)
        stats[sp] += 1
        if sp == "test":
            if len(test) < 300:
                test.append({"id": i, "events": ev, "truth": truth})
            continue
        X, y = featurize(ev, g.footprints)
        out[sp][0].extend(X)
        out[sp][1].extend(y)
    Path("data/synth").mkdir(parents=True, exist_ok=True)
    for sp, (X, y) in out.items():
        np.savez_compressed(f"data/synth/{sp}.npz", X=np.array(X, np.float32), y=np.array(y, np.float32))
    Path("data/synth/test.json").write_text(json.dumps({"assume": ASSUME, "routes": test}), encoding="utf-8")
    print("routes", stats, "train fixes", len(out["train"][1]), "val fixes", len(out["val"][1]),
          "test routes", len(test), "features", FEATURE_NAMES)


if __name__ == "__main__":
    main()
