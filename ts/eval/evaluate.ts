// 합성 시험셋 평가(기기 종류별): 원시 GPS / 걸음만 / 1차 맞춤기 / 2차 맞춤기(믿음 모델 유무·5초 지연·출발점 앎)
// + 머무름 시나리오(북악관 6F). 사용: npm run eval [-- ios|android]  → results/eval_synthetic.<기기>.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createMatcher } from '../src/matcher';
import { createMatcher as createV1 } from './v1/matcher';
import { loadTrustModel } from '../src/trust';
import { g, loadRoutes, mk, q, root, row, score, type Est } from './common';
import { BLD, TARGET, dwellRun } from './dwell';

const load = (f: string) => loadTrustModel(JSON.parse(readFileSync(new URL(f, root), 'utf8')));
const trust1 = load('models/trust_mlp.json'), trust2 = load('models/trust_mlp_v2.json');
const platforms = (process.argv[2] ? [process.argv[2]] : ['ios', 'android']) as ('ios' | 'android')[];
const routes = loadRoutes();
mkdirSync(new URL('results/', root), { recursive: true });

for (const platform of platforms) {
  const M = {
    'raw GPS': mk('none'), 'PDR only (start known)': mk('z'),
    'v1 HMM+trust': mk('edge'), 'v2 HMM': mk('edge'), 'v2 HMM+trust_v2': mk('edge'),
    'v2 default (5s lag)': mk('edge'), 'v2 default (start known)': mk('edge'),
  };
  const v2default = platform === 'android' ? 'v2 HMM+trust_v2' : 'v2 HMM';
  const lat: number[] = [];
  const rs = routes.filter((r) => r.platform === platform);
  for (const r of rs) {
    const ev = r.events, t0 = r.truth[0];
    score(M['raw GPS'], r.truth, ev.flatMap((e) => (e.type === 'fix' ? [{ t: e.t, x: e.x, y: e.y, z: null }] : [])));
    {
      let x = t0.x, y = t0.y, z = t0.z, b0: number | null = null;
      const est: Est[] = [{ t: 0, x, y, z }];
      for (const e of ev) {
        if (e.type === 'step') { const h = (e.heading * Math.PI) / 180; x += 0.7 * Math.sin(h); y += 0.7 * Math.cos(h); est.push({ t: e.t, x, y, z }); }
        if (e.type === 'baro') { if (b0 === null) b0 = e.h; z = t0.z + e.h - b0; est.push({ t: e.t, x, y, z }); }
      }
      score(M['PDR only (start known)'], r.truth, est);
    }
    const runs: [keyof typeof M, any, boolean][] = [
      ['v1 HMM+trust', createV1(g, { platform, trust: trust1 }), false],
      ['v2 HMM', createMatcher(g, { platform }), platform === 'ios'],
      ['v2 HMM+trust_v2', createMatcher(g, { platform, trust: trust2 }), platform === 'android'],
      ['v2 default (start known)', createMatcher(g, { platform, trust: platform === 'android' ? trust2 : null, start: { x: t0.x, y: t0.y, z: t0.z } }), false],
    ];
    for (const [name, m, isDefault] of runs) {
      const est: Est[] = [], lagged: Est[] = [];
      for (const e of ev) {
        const s = performance.now();
        const res = m.push(e);
        if (e.type === 'fix' && isDefault) lat.push(performance.now() - s);
        if (!res) continue;
        est.push({ t: res.t, x: res.x, y: res.y, z: res.z, edge: res.edgeKey, floor: res.floor, area: res.areaKey ?? null });
        const l = res.lagged;
        if (isDefault && l && (!lagged.length || l.t > lagged[lagged.length - 1].t))
          lagged.push({ t: l.t, x: l.x, y: l.y, z: l.z, edge: l.edgeKey, floor: l.floor, area: res.areaKey ?? null });
      }
      score(M[name], r.truth, est);
      if (isDefault) score(M['v2 default (5s lag)'], r.truth, lagged);
    }
  }
  const rows = Object.entries(M).map(([method, a]) => row(method, a));
  // 머무름 시나리오: 북악관 6F 에 머묾, GPS 는 건물 밖으로 번짐(30회)
  const dwell: Record<string, unknown> = {};
  for (const [name, make] of [
    ['v1 HMM+trust', () => createV1(g, { platform, trust: trust1 })],
    ['v2 default', () => createMatcher(g, { platform, trust: platform === 'android' ? trust2 : null })],
    ['v2 default + floorPrior(6F)', () => createMatcher(g, { platform, trust: platform === 'android' ? trust2 : null, floorPrior: { [TARGET]: 1 } })],
  ] as const) {
    let n = 0, inB = 0, on6 = 0, onNet = 0;
    for (let s = 0; s < 30; s++) {
      const m: any = make();
      for (const e of dwellRun(platform, s)) {
        const res = m.push(e);
        if (!res || e.type !== 'fix') continue;
        n++;
        if (res.floor?.startsWith(BLD)) inB++;
        if (res.floor === TARGET) on6++;
        if (res.edgeKey || res.areaKey) onNet++;
      }
    }
    dwell[name] = { in_building: +(inB / n).toFixed(3), on_6F: +(on6 / n).toFixed(3), on_network: +(onNet / n).toFixed(3) };
  }
  const latency = { method: v2default, median_ms: +q(lat, 0.5).toFixed(3), p99_ms: +q(lat, 0.99).toFixed(3), n: lat.length };
  console.log(`\n== ${platform} (${rs.length} routes) ==`);
  console.table(rows);
  console.table(dwell);
  console.log('v2 default per-fix latency (Node):', latency);
  writeFileSync(new URL(`results/eval_synthetic.${platform}.json`, root), JSON.stringify({ routes: rs.length, rows, dwell_bukak_6F: dwell, latency }, null, 1));
}
