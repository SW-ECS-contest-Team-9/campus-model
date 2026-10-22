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

/** 언덕 건물: 바깥 길(z=10)이 2F(z=10) 문으로 들어가고, 1F(z=6)는 같은 자리 아래. 가운데(x=50)에 승강기. */
function hillBuilding(): MapPackage {
  const out = (key: string, x: number) => ({ key, location: 'outdoor' as const, floorKey: null, x, y: 0, z: 10 });
  return {
    buildings: [{ key: 'b', footprint: [[0, -10], [100, -10], [100, 10], [0, 10]] }],
    floors: [{ key: 'f:b:1F', buildingKey: 'b', floorZ: 6 }, { key: 'f:b:2F', buildingKey: 'b', floorZ: 10 }],
    nodes: [out('o0', -60), out('o1', -10),
      node('a2', 0, 0, 10, 'f:b:2F'), node('m2', 50, 0, 10, 'f:b:2F'), node('b2', 100, 0, 10, 'f:b:2F'),
      node('a1', 0, 0, 6, 'f:b:1F'), node('m1', 50, 0, 6, 'f:b:1F'), node('b1', 100, 0, 6, 'f:b:1F')],
    edges: [
      edge('w', 'o0', 'o1', 'walkway', [[-60, 0, 10], [-10, 0, 10]]),
      edge('door', 'o1', 'a2', 'corridor', [[-10, 0, 10], [0, 0, 10]]),
      edge('c2a', 'a2', 'm2', 'corridor', [[0, 0, 10], [50, 0, 10]]), edge('c2b', 'm2', 'b2', 'corridor', [[50, 0, 10], [100, 0, 10]]),
      edge('c1a', 'a1', 'm1', 'corridor', [[0, 0, 6], [50, 0, 6]]), edge('c1b', 'm1', 'b1', 'corridor', [[50, 0, 6], [100, 0, 6]]),
      edge('lift', 'm1', 'm2', 'elevator', [[50, 0, 6], [50, 0, 10]]),
    ],
    walkAreas: [], walkAreaNodes: [],
  };
}

describe('2차: 절대 높이·승강기·기압계 없음', () => {
  it('바깥 평지 길에서 기압 영점을 잡는다', () => {
    const m = createMatcher(hillBuilding());
    for (const e of walk(-58, -14, 0, 0, () => 100, 4)) m.push(e);
    expect(m.baroOffset()).not.toBeNull();
    expect(m.baroOffset()!).toBeCloseTo(-90, 0);
  });

  it('문으로 2F 에 들어가 승강기로 내려가면 1F', () => {
    const m = createMatcher(hillBuilding());
    let r = null;
    for (const e of walk(-58, -14, 0, 0, () => 100, 4)) r = m.push(e);
    for (const e of walk(-12, 48, 40, 0, () => 100, 30)) r = m.push(e);
    expect(r!.floor).toBe('f:b:2F');
    // 승강기: 걸음 없이 기압만 4 m 내려감, GPS 없음
    for (let k = 1; k <= 12; k++) r = m.push({ type: 'baro', t: 90 + k, h: 100 - Math.min(4, k * 0.5) });
    for (const e of walk(52, 90, 103, 0, () => 96, 30)) r = m.push(e);
    expect(r!.floor).toBe('f:b:1F');
    expect(r!.z).toBeCloseTo(6, 0);
  });

  it('기압계가 없으면 사용자가 고른 층을 쓰고, setFloor 로 바꾼다', () => {
    const m = createMatcher(twoFloors(), { userFloor: 'f2' });
    let r = null;
    for (const e of walk(10, 50, 0).filter((e) => e.type !== 'baro')) r = m.push(e);
    expect(r!.floor).toBe('f2');
    m.setFloor('f1');
    for (const e of walk(50, 70, 40).filter((e) => e.type !== 'baro')) r = m.push(e);
    expect(r!.floor).toBe('f1');
  });

  it('실내 길 없는 건물(한림관 꼴)은 건물 자체로 끌어당기고 기압으로 층을 정한다', () => {
    const out = (key: string, x: number) => ({ key, location: 'outdoor' as const, floorKey: null, x, y: 0, z: 10 });
    const pkg: MapPackage = {
      buildings: [{ key: 'h', footprint: [[200, -30], [260, -30], [260, 30], [200, 30]] }],
      floors: [{ key: 'f:h:1F', buildingKey: 'h', floorZ: 10 }, { key: 'f:h:5F', buildingKey: 'h', floorZ: 26 }],
      nodes: [out('o0', 100), out('o1', 195)],
      edges: [edge('w', 'o0', 'o1', 'walkway', [[100, 0, 10], [195, 0, 10]])],
      walkAreas: [], walkAreaNodes: [],
    };
    const m = createMatcher(pkg);
    let r = null;
    for (const e of walk(110, 194, 0, 0, () => 50, 4)) r = m.push(e);
    expect(r!.edgeKey).toBe('w');
    for (const e of walk(196, 230, 70, 0, () => 50, 25)) r = m.push(e);
    expect(r!.buildingKey).toBe('h');
    expect(r!.floor).toBe('f:h:1F');
    // 승강기: 걸음 없이 기압 +16 m, 건물 안 GPS
    for (let k = 1; k <= 20; k++) {
      r = m.push({ type: 'baro', t: 100 + k, h: 50 + Math.min(16, k) });
      r = m.push({ type: 'fix', t: 100 + k + 0.5, x: 230, y: 3, acc: 30 });
    }
    expect(r!.buildingKey).toBe('h');
    expect(r!.floor).toBe('f:h:5F');
  });

  it('GPS 높이(수직 정확도 좋음)로 겹친 층 중 맞는 층을 고른다(안드로이드)', () => {
    const run = (opts: object, vacc: number) => {
      const m = createMatcher(twoFloors(), opts);
      let r = null;
      for (let k = 0; k < 20; k++) {
        r = m.push({ type: 'baro', t: k, h: 0.1 * Math.sin(k) });
        r = m.push({ type: 'fix', t: k + 0.5, x: 50 + Math.sin(k), y: 3, acc: 30, alt: 4.6, vacc });
      }
      return r!.floor;
    };
    expect(run({ gpsAltMaxVacc: 3 }, 1.5)).toBe('f2');
    expect(run({}, 1.5)).toBe(run({ gpsAltMaxVacc: 3 }, 10)); // 꺼져 있거나 수직 정확도가 나쁘면 무시
  });

  it('출력은 늘 길 위(길 밖 상태는 좋은 GPS 가 길에서 멀리 오래 있을 때만)', () => {
    const m = createMatcher(twoFloors());
    // 길에서 30 m 떨어진 좋은 GPS 5개: 아직 길로 끌어당긴다
    let r = null;
    for (let k = 0; k < 5; k++) r = m.push({ type: 'fix', t: k, x: 40 + k, y: 30, acc: 4 });
    expect(r!.edgeKey).not.toBeNull();
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
