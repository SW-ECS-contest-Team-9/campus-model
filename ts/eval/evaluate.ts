// 합성 시험셋 평가(기기 종류별): 원시 GPS / 걸음만(PDR) / 규칙 HMM / HMM+믿음 모델(실시간·5초 지연·출발점 앎).
// 사용: npm run eval  (../data/package.json, ../data/synth/test.json, ../models/trust_mlp.json 필요)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildGraph, segCrossesPoly } from '../src/graph';
import { createMatcher, type SensorEvent } from '../src/matcher';
import { loadTrustModel } from '../src/trust';

interface Truth { t: number; x: number; y: number; z: number; indoor: boolean; edge: string | null }
interface Est { t: number; x: number; y: number; z: number | null; edge?: string | null; floor?: string | null }

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('data/package.json', root), 'utf8'));
const g = buildGraph(pkg);
const trust = loadTrustModel(JSON.parse(readFileSync(new URL('models/trust_mlp.json', root), 'utf8')));
const test = JSON.parse(readFileSync(new URL('data/synth/test.json', root), 'utf8'));
const routes: { id: number; platform: 'ios' | 'android'; events: SensorEvent[]; truth: Truth[] }[] = test.routes;

const nodeBuilding = new Map<string, string | null>(pkg.nodes.map((n: any) => [n.key, n.buildingKey]));
const edgeByKey = new Map(g.edges.map((e) => [e.key, e]));
const floorsByBuilding = new Map<string, { key: string; z: number }[]>();
for (const f of pkg.floors) if (f.floorZ !== null) (floorsByBuilding.get(f.buildingKey) ?? floorsByBuilding.set(f.buildingKey, []).get(f.buildingKey)!).push({ key: f.key, z: f.floorZ });

/** 정답 층: 정답 길의 양 끝 중 높이가 가까운 노드의 층(맞춤기와 같은 규칙). */
function truthFloor(tr: Truth): { floor: string | null; building: string | null } {
  const e = tr.edge ? edgeByKey.get(tr.edge) : undefined;
  if (!e) return { floor: null, building: null };
  const a = g.nodes[e.from], b = g.nodes[e.to];
  const n = Math.abs(a.z - tr.z) <= Math.abs(b.z - tr.z) ? a : b;
  return { floor: n.floorKey, building: nodeBuilding.get(n.key) ?? null };
}

type Acc = { err: number[]; edgeOk: number; edgeN: number; floorOk: number; floorN: number; jumps: number; outN: number; mode: 'edge' | 'z' | 'none' };
const mk = (mode: Acc['mode']): Acc => ({ err: [], edgeOk: 0, edgeN: 0, floorOk: 0, floorN: 0, jumps: 0, outN: 0, mode });

function score(acc: Acc, truth: Truth[], est: Est[]) {
  let k = -1;
  for (const tr of truth) {
    while (k + 1 < est.length && est[k + 1].t <= tr.t + 0.5) k++;
    if (k < 0) continue;
    const e = est[k];
    acc.err.push(Math.hypot(e.x - tr.x, e.y - tr.y));
    if (acc.mode === 'edge' && tr.edge) { acc.edgeN++; if (e.edge === tr.edge) acc.edgeOk++; }
    if (tr.indoor && acc.mode !== 'none') {
      const tf = truthFloor(tr);
      if (!tf.floor) continue;
      acc.floorN++;
      let ef = e.floor ?? null;
      if (acc.mode === 'z' && e.z !== null && tf.building) {
        // 걸음만: 같은 건물을 안다고 치고 가장 가까운 층 높이
        const fl = floorsByBuilding.get(tf.building) ?? [];
        ef = fl.reduce<{ key: string; z: number } | null>((b, f) => (!b || Math.abs(f.z - e.z!) < Math.abs(b.z - e.z!) ? f : b), null)?.key ?? null;
      }
      if (ef === tf.floor) acc.floorOk++;
    }
  }
  for (let i = 1; i < est.length; i++) {
    const a = est[i - 1], b = est[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) >= 8 && g.footprints.some((fp) => segCrossesPoly(a.x, a.y, b.x, b.y, fp))) acc.jumps++;
  }
  acc.outN += est.length;
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const out: any = { routes: routes.length, platforms: {} };

for (const platform of ['ios', 'android'] as const) {
  const methods: Record<string, Acc> = {
    'raw GPS': mk('none'), 'PDR only (start known)': mk('z'), HMM: mk('edge'), 'HMM+trust': mk('edge'),
    'HMM+trust (5s lag)': mk('edge'), 'HMM+trust (start known)': mk('edge'),
  };
  const lat: number[] = [];
  const rs = routes.filter((r) => r.platform === platform);
  for (const r of rs) {
    const ev = r.events;
    const t0 = r.truth[0];
    score(methods['raw GPS'], r.truth, ev.flatMap((e) => (e.type === 'fix' ? [{ t: e.t, x: e.x, y: e.y, z: null }] : [])));
    {
      let x = t0.x, y = t0.y, z = t0.z, b0: number | null = null;
      const est: Est[] = [{ t: 0, x, y, z }];
      for (const e of ev) {
        if (e.type === 'step') { const h = (e.heading * Math.PI) / 180; x += 0.7 * Math.sin(h); y += 0.7 * Math.cos(h); est.push({ t: e.t, x, y, z }); }
        if (e.type === 'baro') { if (b0 === null) b0 = e.h; z = t0.z + e.h - b0; est.push({ t: e.t, x, y, z }); }
      }
      score(methods['PDR only (start known)'], r.truth, est);
    }
    for (const name of ['HMM', 'HMM+trust', 'HMM+trust (start known)'] as const) {
      const m = createMatcher(g, {
        platform, trust: name === 'HMM' ? null : trust,
        start: name === 'HMM+trust (start known)' ? { x: t0.x, y: t0.y, z: t0.z } : null,
      });
      const est: Est[] = [];
      const lagged: Est[] = [];
      for (const e of ev) {
        const s = performance.now();
        const res = m.push(e);
        if (e.type === 'fix' && name === 'HMM+trust') lat.push(performance.now() - s);
        if (!res) continue;
        est.push({ t: res.t, x: res.x, y: res.y, z: res.z, edge: res.edgeKey, floor: res.floor });
        const l = res.lagged;
        if (name === 'HMM+trust' && l && (!lagged.length || l.t > lagged[lagged.length - 1].t))
          lagged.push({ t: l.t, x: l.x, y: l.y, z: l.z, edge: l.edgeKey, floor: l.floor });
      }
      score(methods[name], r.truth, est);
      if (name === 'HMM+trust') score(methods['HMM+trust (5s lag)'], r.truth, lagged);
    }
  }
  const rows = Object.entries(methods).map(([method, a]) => ({
    method,
    median_m: +q(a.err, 0.5).toFixed(1), p90_m: +q(a.err, 0.9).toFixed(1),
    edge_rate: a.mode === 'edge' ? +(a.edgeOk / a.edgeN).toFixed(3) : null,
    floor_rate: a.mode !== 'none' ? +(a.floorOk / a.floorN).toFixed(3) : null,
    wall_jumps_per_1000: +((1000 * a.jumps) / Math.max(1, a.outN)).toFixed(1),
  }));
  const latency = { median_ms: +q(lat, 0.5).toFixed(3), p99_ms: +q(lat, 0.99).toFixed(3), n: lat.length };
  console.log(`\n== ${platform} (${rs.length} routes) ==`);
  console.table(rows);
  console.log('HMM+trust per-fix latency (Node):', latency);
  out.platforms[platform] = { routes: rs.length, rows, latency };
}
mkdirSync(new URL('results/', root), { recursive: true });
writeFileSync(new URL('results/eval_synthetic.json', root), JSON.stringify(out, null, 1));
