// GPS 믿음 모델(작은 MLP) 순수 TS 계산. 가중치는 models/trust_mlp.json(약 10 KB).
// 같은 모델의 ONNX(models/trust_mlp.onnx)는 onnxruntime-react-native 로도 돌릴 수 있지만, 이 크기에선 순수 TS 가 더 빠르고 단순하다.

export interface TrustModelJson {
  name: string; version: number; features: string[];
  mean: number[]; std: number[];
  layers: { W: number[][]; b: number[] }[];
  sigma_scale: number;
}

export interface TrustModel {
  /** 특징 → 2차원 정규 오차의 sigma(m). */
  sigma(features: number[]): number;
}

export function loadTrustModel(json: TrustModelJson): TrustModel {
  const layers = json.layers.map((L) => ({ W: L.W.map((r) => Float64Array.from(r)), b: Float64Array.from(L.b) }));
  return {
    sigma(f: number[]): number {
      // 모델이 아는 앞쪽 특징만 쓴다(1차 모델 11개, 2차 13개)
      let h = json.mean.map((m, i) => (f[i] - m) / json.std[i]);
      layers.forEach((L, li) => {
        const o = new Array<number>(L.b.length);
        for (let r = 0; r < L.b.length; r++) {
          let s = L.b[r];
          const w = L.W[r];
          for (let c = 0; c < h.length; c++) s += w[c] * h[c];
          o[r] = li < layers.length - 1 ? Math.max(0, s) : s;
        }
        h = o;
      });
      return Math.exp(h[0]) * json.sigma_scale;
    },
  };
}
