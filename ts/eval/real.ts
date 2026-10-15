// 실제 세션(정답 없음) 정성 평가: 경로 길이·튐·길 위 비율·불확실 비율·층 순서. 집계값만 출력한다.
// 사용: npm run eval:real -- <사건열.json(저장소 밖)> [걸음 기준 거리 m] [ios|android] [결과 이름]
import { readFileSync, writeFileSync } from 'node:fs';
import { createMatcher, type SensorEvent } from '../src/matcher';
import { createMatcher as createV1 } from './v1/matcher';
import { loadTrustModel } from '../src/trust';
import { g, q, root } from './common';

const load = (f: string) => loadTrustModel(JSON.parse(readFileSync(new URL(f, root), 'utf8')));
const ev: SensorEvent[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pedo = Number(process.argv[3] ?? NaN);
const platform = (process.argv[4] ?? 'ios') as 'ios' | 'android';
const outName = process.argv[5] ?? 'eval_real_c03.v2';
const has = { steps: ev.some((e) => e.type === 'step'), baro: ev.some((e) => e.type === 'baro') };

function summary(pts: { t: number; x: number; y: number; on: boolean; bld?: boolean; unc: boolean; floor: string | null }[]) {
  const d = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const len = d.reduce((a, b) => a + b, 0);
  // 층 순서: 10초 넘게 머문 층만, 이어진 같은 층은 하나로
  const seq: string[] = [];
  let cur: string | null = null, since = 0;
  for (const p of pts) {
    if (p.floor !== cur) { cur = p.floor; since = p.t; }
    else if (cur && p.t - since >= 10 && seq[seq.length - 1] !== cur) seq.push(cur);
  }
  return {
    path_m: +len.toFixed(0), path_over_pedometer: isFinite(pedo) ? +(len / pedo).toFixed(2) : null,
    step_median_m: +q(d, 0.5).toFixed(1), step_p90_m: +q(d, 0.9).toFixed(1), jumps_over_20m: d.filter((v) => v > 20).length,
    on_network: +(pts.filter((p) => p.on).length / pts.length).toFixed(3), in_bare_building: +(pts.filter((p) => p.bld).length / pts.length).toFixed(3), uncertain: +(pts.filter((p) => p.unc).length / pts.length).toFixed(3),
    floor_sequence: seq.map((f) => f.replace(/^f:/, '')).join(' > '),
  };
}
const out: Record<string, unknown> = {
  'raw GPS': summary(ev.flatMap((e) => (e.type === 'fix' ? [{ t: e.t, x: e.x, y: e.y, on: false, unc: false, floor: null }] : []))),
};
const runs: [string, any][] = [
  ['v1 HMM+trust', createV1(g, { platform, trust: load('models/trust_mlp.json') })],
  ['v2 default', createMatcher(g, { platform, trust: platform === 'android' ? load('models/trust_mlp_v2.json') : null })],
];
for (const [name, m] of runs) {
  const pts = ev.map((e) => m.push(e)).filter((r: any) => r).map((r: any) => ({ t: r.t, x: r.x, y: r.y, on: r.edgeKey !== null || !!r.areaKey || !!r.buildingKey, bld: !!r.buildingKey, unc: r.state === 'uncertain', floor: r.floor }));
  out[name] = summary(pts);
}
console.log(JSON.stringify(out, null, 1));
writeFileSync(new URL(`results/${outName}.json`, root), JSON.stringify({ note: '실제 세션, 정답 없음, 집계값만.', inputs: has, pedometer_m: pedo, platform, ...out }, null, 1));
