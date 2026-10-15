import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMatcher, type SensorEvent } from '../src/matcher';
import { FeatureState } from '../src/features';
import { loadTrustModel } from '../src/trust';
import type { MapPackage } from '../src/graph';

const edge = (key: string, from: string, to: string, kind: string, geometry: [number, number, number][], direction: 'both' | 'forward' = 'both') => {
  let len = 0;
  for (let i = 1; i < geometry.length; i++) len += Math.hypot(geometry[i][0] - geometry[i - 1][0], geometry[i][1] - geometry[i - 1][1], geometry[i][2] - geometry[i - 1][2]);
  return { key, from, to, kind, direction, pedestrianAccess: 'allowed', lengthM: len, geometry };
};
const node = (key: string, x: number, y: number, z: number, floorKey: string) => ({ key, location: 'indoor' as const, floorKey, x, y, z });

/** 두 층 건물: 1F(z=0)·2F(z=4) 복도가 같은 자리에 겹치고, 동쪽 끝(x=100)에만 계단. */
function twoFloors(): MapPackage {
  return {
    buildings: [{ key: 'b', footprint: null }],
    floors: [{ key: 'f1', buildingKey: 'b', floorZ: 0 }, { key: 'f2', buildingKey: 'b', floorZ: 4 }],
    nodes: [node('a1', 0, 0, 0, 'f1'), node('b1', 100, 0, 0, 'f1'), node('a2', 0, 0, 4, 'f2'), node('b2', 100, 0, 4, 'f2')],
    edges: [
      edge('c1', 'a1', 'b1', 'corridor', [[0, 0, 0], [100, 0, 0]]),
      edge('c2', 'a2', 'b2', 'corridor', [[0, 0, 4], [100, 0, 4]]),
      edge('st', 'b1', 'b2', 'stairs', [[100, 0, 0], [108, 0, 4]]),
    ],
    walkAreas: [], walkAreaNodes: [],
  };
}

/** 동쪽으로 걷기: 1초마다 걸음 2개(1.4 m), 기압, GPS. */
function walk(x0: number, x1: number, t0: number, y = 0, h: (x: number) => number = () => 0, acc = 8): SensorEvent[] {
  const ev: SensorEvent[] = [];
  const dir = Math.sign(x1 - x0);
  let t = t0;
  for (let x = x0; dir > 0 ? x <= x1 : x >= x1; x += 1.4 * dir) {
    ev.push({ type: 'step', t: t + 0.2, heading: dir > 0 ? 90 : 270 }, { type: 'step', t: t + 0.7, heading: dir > 0 ? 90 : 270 });
    ev.push({ type: 'baro', t: t + 0.9, h: h(x) });
    ev.push({ type: 'fix', t: t + 1, x: x + 1.4 * dir, y, acc });
    t += 1;
  }
  return ev;
}

describe('createMatcher', () => {
  it('기압만 올라가도 계단이 없으면 층을 바꾸지 않는다', () => {
    const m = createMatcher(twoFloors(), { start: { x: 10, y: 0, z: 0 } });
    let r = null;
    for (const e of walk(10, 50, 0)) r = m.push(e);
    expect(r!.floor).toBe('f1');
    // 복도 가운데에서 서서 기압만 +4 m (승강기 흉내지만 승강기 길 없음)
    for (let k = 1; k <= 10; k++) {
      r = m.push({ type: 'baro', t: 40 + k, h: Math.min(4, k * 0.8) });
      r = m.push({ type: 'fix', t: 40 + k + 0.5, x: 51, y: 0, acc: 8 });
    }
    expect(r!.floor).toBe('f1');
    expect(r!.edgeKey).toBe('c1');
  });

  it('계단을 지나 올라가면 2층이 된다', () => {
    const m = createMatcher(twoFloors(), { start: { x: 10, y: 0, z: 0 } });
    let r = null;
    for (const e of walk(10, 99, 0)) r = m.push(e);
    expect(r!.floor).toBe('f1');
    // 계단 오르기(동쪽 8 m 에 4 m 오름), 다시 서쪽 2층 복도로
    for (const e of walk(100, 107, 70, 0, (x) => ((x - 100) / 8) * 4)) r = m.push(e);
    for (const e of walk(100, 60, 80, 0, () => 4)) r = m.push(e);
    expect(r!.floor).toBe('f2');
    expect(r!.edgeKey).toBe('c2');
    expect(r!.z).toBeCloseTo(4, 0);
  });

  it('일방통행 길은 거꾸로 따라가지 않는다', () => {
    // 남쪽 y=0 길은 서→동 일방, 북쪽 y=8 길은 양방. 사람은 y=2 근처에서 동→서로 걷는다.
    const pkg: MapPackage = {
      buildings: [], floors: [],
      nodes: [0, 100].map((x, i) => ({ key: 'n' + i, location: 'outdoor' as const, floorKey: null, x, y: 0, z: 0 })),
      edges: [
        edge('oneway', 'n0', 'n1', 'walkway', [[0, 0, 0], [100, 0, 0]], 'forward'),
        edge('loop', 'n0', 'n1', 'walkway', [[0, 0, 0], [0, 8, 0], [100, 8, 0], [100, 0, 0]]),
      ],
      walkAreas: [], walkAreaNodes: [],
    };
    const m = createMatcher(pkg, { offNetwork: false });
    const keys: (string | null)[] = [];
    for (const e of walk(90, 10, 0, 2, () => 0, 6)) {
      const r = m.push(e);
      if (r && e.type === 'fix') keys.push(r.edgeKey);
    }
    const tail = keys.slice(5);
    expect(tail.filter((k) => k === 'loop').length / tail.length).toBeGreaterThan(0.9);
  });

  it('같은 입력이면 같은 출력(결정적)', () => {
    const run = () => {
      const m = createMatcher(twoFloors());
      return walk(10, 60, 0).map((e) => JSON.stringify(m.push(e)));
    };
    expect(run()).toEqual(run());
  });
});

describe('특징·믿음 모델', () => {
  it('Python 특징 계산과 같다', () => {
    const fx = JSON.parse(readFileSync(new URL('./fixtures/features_parity.json', import.meta.url), 'utf8'));
    const st = new FeatureState({ footprints: fx.footprints }, fx.platform);
    const got: number[][] = [];
    for (const e of fx.events) {
      if (e.type === 'step') st.step(e.t, e.heading);
      else if (e.type === 'baro') st.baroSample(e.t, e.h);
      else got.push(st.fix(e.t, e.x, e.y, e.acc, e.speed, e.course));
    }
    expect(got.length).toBe(fx.features.length);
    got.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(fx.features[i][j], 6)));
  });

  it('같은 정확도 값이면 iOS 를 안드로이드보다 덜 믿는다', () => {
    const tm = loadTrustModel(JSON.parse(readFileSync(new URL('../../models/trust_mlp.json', import.meta.url), 'utf8')));
    const f = [Math.log(15), 1, 1, Math.log1p(1), 0, Math.log1p(3), 0, 0, 2, 0];
    expect(tm.sigma([...f, 0])).toBeGreaterThan(tm.sigma([...f, 1]));
  });
});
