"""GPS 믿음 모델 학습: 특징 → ln(실제 오차 m). 작은 MLP(10→16→16→1).

출력: models/trust_mlp.json(TS 순수 구현용 가중치), models/trust_mlp.onnx(opset 13), results/trust_train.json.
HMM 이 쓰는 sigma = exp(예측) × sigma_scale (2차원 정규 오차의 sigma 가 되도록 검증셋 중앙값으로 맞춤).
"""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from skl2onnx import to_onnx
from sklearn.linear_model import LinearRegression
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import FEATURE_NAMES

RAYLEIGH_MEDIAN = 1.1774


def main():
    tr = np.load("data/synth/train.npz")
    va = np.load("data/synth/val.npz")
    Xt, yt, Xv, yv = tr["X"], tr["y"], va["X"], va["y"]
    pipe = make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=(16, 16), max_iter=60, early_stopping=True,
                                                        random_state=0, batch_size=1024, learning_rate_init=3e-3))
    pipe.fit(Xt, yt)
    pv = pipe.predict(Xv)
    acc_only = LinearRegression().fit(Xt[:, :1], yt)
    pa = acc_only.predict(Xv[:, :1])
    raw = Xv[:, 0]  # ln(acc) 그대로
    scale = float(np.median(np.exp(yv - pv)) / RAYLEIGH_MEDIAN)
    rep = {
        "n_train": int(len(yt)), "n_val": int(len(yv)),
        "val_mae_log": {"mlp": float(np.abs(pv - yv).mean()), "acc_linear": float(np.abs(pa - yv).mean()),
                         "acc_raw": float(np.abs(raw - yv).mean())},
        "val_corr": {"mlp": float(np.corrcoef(pv, yv)[0, 1]), "acc_raw": float(np.corrcoef(raw, yv)[0, 1])},
        "sigma_scale": scale,
    }
    sc, mlp = pipe.steps[0][1], pipe.steps[1][1]
    model = {
        "name": "trust_mlp", "version": 1, "features": FEATURE_NAMES,
        "mean": sc.mean_.tolist(), "std": sc.scale_.tolist(),
        "layers": [{"W": W.T.round(6).tolist(), "b": b.round(6).tolist()} for W, b in zip(mlp.coefs_, mlp.intercepts_)],
        "activation": "relu", "output": "ln_err_m", "sigma_scale": round(scale, 5),
    }
    Path("models").mkdir(exist_ok=True)
    Path("models/trust_mlp.json").write_text(json.dumps(model), encoding="utf-8")
    onx = to_onnx(pipe, Xt[:1].astype(np.float32), target_opset=13)
    Path("models/trust_mlp.onnx").write_bytes(onx.SerializeToString())
    # ONNX 와 JSON 순수 계산이 같은지 확인
    sess = ort.InferenceSession("models/trust_mlp.onnx")
    po = sess.run(None, {sess.get_inputs()[0].name: Xv[:1000]})[0].ravel()
    h = (Xv[:1000] - model["mean"]) / model["std"]
    for i, L in enumerate(model["layers"]):
        h = h @ np.array(L["W"]).T + np.array(L["b"])
        if i < len(model["layers"]) - 1:
            h = np.maximum(h, 0)
    rep["onnx_vs_json_maxdiff"] = float(np.abs(po - h.ravel()).max())
    rep["onnx_bytes"] = Path("models/trust_mlp.onnx").stat().st_size
    rep["json_bytes"] = Path("models/trust_mlp.json").stat().st_size
    Path("results").mkdir(exist_ok=True)
    Path("results/trust_train.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
