# campus-model — 기기 안 위치 보정 모델 (2차 = v2, 아래 1차 기록 유지)

## INTEGRATION (v2, 앱에 넣는 법)
목표: 위치를 이미 만든 통로(길·보행 면)로, 길이 없는 건물(한림관·청운관)은 건물 자체로 **끌어당긴다**. 출력은 늘 길·면·건물 위이고, 길 밖 상태는 아주 좋은 GPS 가 모든 길에서 25 m 넘게 10번 이어질 때만 나온다. `state: 'uncertain'` 은 표시용 꼬리표일 뿐 끌어당김을 멈추지 않는다.

1. 복사(외부 의존 없음, Node API 없음, Hermes 안전, 결정적): `ts/src/{graph,features,trust,matcher,bench,index}.ts` → `C:\campus-client\src\location\matcher\`, 모델 `models/trust_mlp_v2.json`(약 12 KB) → 같은 폴더.
2. 꾸러미를 받은 뒤 한 번(그래프 준비 Node 40~60 ms, 기기 추정 0.3~0.6 s → 첫 화면 뒤 `InteractionManager.runAfterInteractions`):
   ```ts
   import { createDefaultMatcher } from './matcher';
   import trustJson from './matcher/trust_mlp_v2.json';
   const matcher = createDefaultMatcher(pkg, Platform.OS === 'ios' ? 'ios' : 'android', trustJson);
   ```
   (안드로이드만 믿음 모델을 쓰고 iOS 는 규칙 sigma. 합성 평가 결과에 따른 기본값.)
3. 입력(좌표는 EPSG:5186 m, `t` 는 초, 같은 시계):
   - 위치: `matcher.push({ type: 'fix', t, x, y, acc, speed, course })` (없으면 -1)
   - 걸음: `matcher.push({ type: 'step', t, heading })` (걸음 1개마다, 도, 0 = 북, 시계방향)
   - 기압: `matcher.push({ type: 'baro', t, h })` (상대 높이 m, 1 Hz 정도)
4. 출력(push 마다): `{ x, y, z, floor, edgeKey, areaKey, buildingKey, state, lagged }`. 점은 `x, y` 를 그대로 그린다(이미 통로 위). `edgeKey`/`areaKey`/`buildingKey` 중 하나가 늘 채워진다(길 밖 상태 빼고). `lagged` 는 5초 늦은 더 정확한 값(기록용).
5. **기압계 없는 기기**(일부 구형 Galaxy A): `baro` 를 안 보내면 된다. 사용자가 층을 고르면 `matcher.setFloor('f:북악관:6F')`(처음부터 알면 `createDefaultMatcher(pkg, p, trustJson, { userFloor })`). 그 건물 안에서는 고른 층만 쓴다. 층을 안 고르면 층은 길 그래프(계단·승강기 통과)로만 바뀐다.
6. 선택: 출발지를 알면 `{ start: { x, y, z } }`, 자주 머무는 층을 알면 `{ floorPrior: { 'f:북악관:6F': 1 } }`(기압 기준을 아직 못 잡았을 때만 쓰임).
7. 기기에서 속도 재기: `console.log('[bench]', JSON.stringify(benchmarkMatcher(pkg, {}, 600)))` → `adb logcat -s ReactNativeJS | findstr bench`.

v2 에서 바뀐 것과 평가는 아래 "2차 결과" 절과 볼트 노트(백엔드/작업로그/2026-10-15-위치-보정-모델-1차.md 의 2차 절).

서경대학교 길안내 앱(`C:\campus-client`)용. 규칙 HMM 길 맞춤을 뼈대로 두고, GPS 를 얼마나 믿을지(오차 크기)를 작은 신경망이 정한다.
학습·평가는 **합성 자료**로만 했다. 실제 정답 동선은 아직 없다.

- Python(uv, 3.12): 잡음 집계, 합성 생성기, 믿음 모델 학습·내보내기
- TypeScript(`ts/`): 기기에서 도는 맞춤기 `createMatcher`(Hermes 호환, 네트워크·Node API 없음), 평가·벤치마크

## 구성
| 경로 | 내용 |
|---|---|
| `src/campus_model/fetch_package.py` | 로컬 백엔드(127.0.0.1:8010) 최신 지도 꾸러미 받기 + sha256 확인 → `data/package.json` |
| `src/campus_model/fit_noise.py` | 실제 세션 위치 기록 → `params/noise_stats.json`(분위수·비율만. 원시 위치는 저장소에 넣지 않음) |
| `src/campus_model/simulate.py` | 합성 동선(길·보행 면·계단·승강기·멈춤) + iPhone/안드로이드 GPS·걸음·기압 생성. 경로(출발·도착 노드)별로 train/val/test 분할 |
| `src/campus_model/features.py` ↔ `ts/src/features.ts` | 믿음 모델 입력 11개(같은 계산, 동치 시험 있음) |
| `src/campus_model/train_trust.py` | MLP 11→16→16→1 학습, `models/trust_mlp.json`·`models/trust_mlp.onnx` 내보내기 |
| `src/campus_model/real_events.py` | 실제 세션 → 맞춤기 사건열(저장소 밖에만 씀) |
| `ts/src/matcher.ts` | HMM 맞춤기 |
| `ts/src/trust.ts` | 믿음 모델 순수 TS 계산(JSON 가중치) |
| `ts/src/bench.ts` | 기기에서 부를 수 있는 벤치마크 `benchmarkMatcher` |
| `ts/eval/*.ts` | 합성 평가, 실제 세션 정성 평가, Node 벤치마크 |

## 다시 만들기
```powershell
cd C:\campus-model
uv sync
uv run python -m campus_model.fetch_package                     # 백엔드가 127.0.0.1:8010 에 떠 있어야 함
uv run python -m campus_model.fit_noise <s_locations.json>      # 원시 위치 파일은 저장소 밖에 둘 것
uv run python -m campus_model.simulate 2000 7                   # 경로 2000개, 시드 7 (약 2분)
uv run python -m campus_model.train_trust                       # 약 20초
cd ts; npm i
npm test                                                        # vitest
npm run eval                                                    # 합성 시험셋 → results/eval_synthetic.json
npm run eval:real -- <사건열.json> 1066                         # 실제 세션(정답 없음) → results/eval_real_c03.json
npm run bench
```
같은 시드면 같은 자료가 나온다. `data/`, 생성물은 git 에서 뺐다. 커밋하는 모델은 `models/trust_mlp.json`(약 11 KB), `models/trust_mlp.onnx`(약 3 KB) 뿐.

## 방법
- **상태**: 길 위 점(GPS·예측점을 각 길에 투영), 보행 면(점이 면 안), 길 밖(바깥이고 GPS 가 좋고 길에서 20 m 넘게 떨어질 때만).
- **관측 점수**: 2차원 정규(sigma) + 튐 대비 꼬리(3 %). GPS 오차는 시간상 이어지므로 점수에 0.3 을 곱한다.
  - 규칙 HMM: sigma = 보고 정확도(5~50 m로 자름)
  - HMM+trust: sigma = 믿음 모델 예측(같은 범위로 자름)
- **이동 점수**: 길 그래프 최단거리(방향 지킴) vs 걸음 거리(0.7 m×걸음) + |기압 변화|. 층은 길을 따라서만 바뀌므로 계단·승강기·경사로를 지나야 한다. 기압 변화와 후보 높이 차이는 부드러운 증거(σ 0.6 m).
- **GPS 가 없을 때**: 걸음 6개(약 4 m)마다 예측점으로, 기압이 2.5 m 넘게 바뀌면 직전 위치로 한 번씩 갱신.
- **출력**: 실시간 최선 상태 + `lagged`(5초 고정 지연 역추적).
- **기기 종류**: `platform: 'ios' | 'android'`. 생성기 잡음 분포, 믿음 모델 입력(`is_android`), 맞춤기 옵션에 다 들어간다. 같은 정확도 값이면 iOS 를 덜 믿는다(시험 있음).
  - ios = C03(iPhone, 2026-10-13) 집계값. android = **가정값**(정확도 ×0.5, 실내 오차 배수 1.0, 큰 튐 1/3, 실내 끊김 적음). 사용자 현장 관찰(같은 길에서 안드로이드가 확실히 낫다, 한림관 등)에 맞춘 것이며 안드로이드 세션이 모이면 다시 맞춘다.

## 결과(합성 시험셋, 경로 198개)
`results/eval_synthetic.json`. 오차는 수평 m, 1 Hz 정답 대비. "걸음만"은 정답 출발점을 알려 준 것(유리한 조건).
층 정답률은 실내 구간만. 벽 통과 = 한 번에 8 m 넘게 움직이며 건물 외곽선을 가로지른 횟수(출력 1000개당).

| 기기 | 방법 | 중앙 | 90 % | 길 정답 | 층 정답 | 벽 통과 |
|---|---|---|---|---|---|---|
| ios | 원시 GPS | 28.1 | 85.0 | — | — | 54.8 |
| ios | 걸음만(출발점 앎) | 24.3 | 61.0 | — | 0.975 | 0 |
| ios | HMM | 23.1 | 60.4 | 0.140 | 0.238 | 1.9 |
| ios | HMM+trust | 23.0 | 65.9 | 0.142 | 0.252 | 1.9 |
| ios | HMM+trust 5초 지연 | 22.3 | 65.2 | 0.148 | 0.256 | 6.7 |
| ios | HMM+trust 출발점 앎 | 22.1 | 66.2 | 0.155 | 0.359 | 1.8 |
| android | 원시 GPS | 12.1 | 35.7 | — | — | 19.9 |
| android | 걸음만(출발점 앎) | 23.3 | 60.6 | — | 0.951 | 0 |
| android | HMM | 7.5 | 33.0 | 0.285 | 0.491 | 1.9 |
| android | HMM+trust | 7.2 | 32.6 | 0.302 | 0.513 | 1.8 |
| android | HMM+trust 5초 지연 | 7.0 | 32.0 | 0.322 | 0.517 | 5.2 |
| android | HMM+trust 출발점 앎 | 7.2 | 32.5 | 0.313 | 0.599 | 1.8 |

믿음 모델 자체(검증셋 ln 오차 MAE): 보고 정확도 그대로 0.93 → 정확도만 선형 0.77 → MLP 0.67. 상관 0.34 → 0.56.

실제 C03(iPhone, 위치만 — 걸음·기압 없이 돌림, 정답 없음, `results/eval_real_c03.json`):
| | 경로 길이 | 걸음 기준(1066 m) 대비 | 20 m 넘는 튐 | 길 위 비율 |
|---|---|---|---|---|
| 원시 GPS | 3110 m | 2.92 | 43 | 0 |
| HMM | 322 m | 0.30 | 6 | 1.0 |
| HMM+trust | 465 m | 0.44 | 11 | 1.0 |
HMM 은 튐을 거의 없앴지만 걸음 자료 없이 돌려 너무 덜 움직인다(이 세션은 승강기로 42 m 오르고 계단으로 내려온 것이라 수평 이동 자체가 작다. 걸음 기준 1066 m 엔 계단 걸음이 들어 있음). 출력의 80 % 가 `uncertain`.

## 한계
- 합성 자료로만 학습·평가. 믿음 모델이 배운 것은 **생성기의 가정**(실내 배수, 속도 무효 시 배수 등)이다. 실제 iPhone/안드로이드 오차와 다를 수 있다.
- 층 정답률이 낮다(실내 iOS 25 %, 안드로이드 51 %). 같은 자리에 층이 겹쳐 있고 기압은 상대값뿐이라, 처음 층을 모르거나 GPS 가 다른 층 후보로 끌면 회복이 늦다. 출발점을 알면 나아진다. 다음 차례: 출입구(알려진 높이)에서 절대 높이 잡기, 층별 사전확률, 기압 기준 재설정.
- 길 정답률이 낮다(iOS 14 %): 길이 촘촘하고 iOS 실내 GPS 치우침이 수십 m 라 이웃 길과 구분이 안 된다. 평균 오차는 걸음만(출발점 앎)과 비슷한 수준.
- 안드로이드 잡음은 실측 없는 가정값.
- 걸음 이동 학습(부품 2: 보폭·방향, 이동 상태 분류)은 아직 안 함. 고정 보폭 0.7 m.

## 클라이언트 통합 (`C:\campus-client`, `src/location/snapToNetwork`)
대상: Android, Galaxy S21(Exynos 2100, 8 GB, arm64-v8a), Expo React Native 개발 빌드, Hermes.

1. `ts/src/*.ts`(graph, features, trust, matcher, bench, index)를 `src/location/matcher/` 로 복사. 외부 의존 없음. Node API 없음(시간은 `performance.now()` 없으면 `Date.now()`).
2. `models/trust_mlp.json` 을 앱에 넣고 `import trustJson from './trust_mlp.json'` → `loadTrustModel(trustJson)`.
3. 꾸러미를 받은 뒤 한 번:
   ```ts
   const matcher = createMatcher(pkg, { trust: loadTrustModel(trustJson), platform: Platform.OS === 'ios' ? 'ios' : 'android' });
   ```
   꾸러미가 바뀌면 다시 만든다(그래프 준비 약 40~60 ms Node, 기기 추정 0.3~0.6 s — 첫 화면 뒤에 하거나 InteractionManager 로 미룸).
4. 센서를 그대로 넣는다(좌표는 EPSG:5186 m 로 바꿔서):
   - 위치: `push({ type:'fix', t, x, y, acc: accuracy, speed, course })` (속도·방향 없으면 -1)
   - 걸음: `push({ type:'step', t, heading })` (heading: 도, 0=북, 시계방향. 걸음 감지기 1걸음마다)
   - 기압: `push({ type:'baro', t, h })` (상대 높이 m, 1 Hz 정도)
   - `t` 는 초(같은 시계). 결과 `{ x, y, z, floor, edgeKey, state, lagged }` 를 지도 점·층 표시에 쓴다. `state === 'uncertain'` 이면 점을 흐리게.
   - 출발지를 사용자가 고르면 `start: { x, y, z }` 를 넘긴다(층 판정이 좋아짐).
5. 기존 `snapToNetwork` 는 이 결과의 `x, y, edgeKey` 로 바꾸면 된다.

### ONNX 경로(선택)
`models/trust_mlp.onnx`: opset 13 + `ai.onnx.ml` 1, 연산 MatMul·Add·Relu·Reshape·Cast·Scaler. 입력 `X` float32 [N,11], 출력 ln(오차 m). sigma = exp(출력) × `sigma_scale`(JSON 안 값, 0.909).
`onnxruntime-react-native`(Android arm64 전체 빌드)에서 돈다. 축소(.ort, 최소 연산) 빌드를 쓰면 `ai.onnx.ml` Scaler 가 빠질 수 있으니 그땐 JSON 의 mean/std 로 직접 정규화하고 MLP 부분만 쓰거나 순수 TS 경로를 쓴다.
MVP 는 **순수 TS(JSON) 경로 권장**: 연산이 400번 남짓이라 ONNX 호출 비용(브리지·텐서 생성)이 더 크다.

### 메모리·CPU
- 그래프: 노드 221개 → 거리표 221²×8 B ≈ 0.4 MB, 그 밖 길·격자 < 0.5 MB. 믿음 모델 11 KB. 합 약 1 MB.
- Node(PC) 한 위치당: 중앙 0.2~0.6 ms, p99 2~6 ms (`npm run eval`, `npm run bench`).
- S21 추정(보수적으로 ×10, Hermes 는 JIT 없음): 중앙 2~6 ms, p99 20~60 ms. 위치가 1초에 1번이라 CPU 1 % 안팎(추정).
- 기기에서 재기: 개발 빌드에서
  ```ts
  import { benchmarkMatcher } from './matcher';
  console.log('[bench]', JSON.stringify(benchmarkMatcher(pkg, { trust, platform: 'android' }, 600)));
  ```
  → `adb logcat -s ReactNativeJS | findstr bench`. `buildMs`, `medianMs`, `p99Ms` 를 기록해 이 표를 실측으로 바꾼다.
