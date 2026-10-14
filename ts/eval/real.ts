// 실제 세션(정답 없음) 정성 평가: 경로 길이·튐·길 위 비율. 집계값만 출력한다.
// 사용: npm run eval:real -- <사건열.json(저장소 밖)> [걸음 기준 거리 m]
import { readFileSync, writeFileSync } from 'node:fs';
import { buildGraph } from '../src/graph';
import { createMatcher, type SensorEvent } from '../src/matcher';
import { loadTrustModel } from '../src/trust';
const root = new URL('../../', import.meta.url);
const g = buildGraph(JSON.parse(readFileSync(new URL('data/package.json', root), 'utf8')));
const trust = loadTrustModel(JSON.parse(readFileSync(new URL('models/trust_mlp.json', root), 'utf8')));
const ev: SensorEvent[] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pedo = Number(process.argv[3] ?? NaN);
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function summary(pts: { x: number; y: number; on: boolean; unc: boolean }[]) {
  const d = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const len = d.reduce((a, b) => a + b, 0);
  return {
    path_m: +len.toFixed(0), path_over_pedometer: isFinite(pedo) ? +(len / pedo).toFixed(2) : null,
    step_median_m: +q(d, 0.5).toFixed(1), step_p90_m: +q(d, 0.9).toFixed(1), jumps_over_20m: d.filter((v) => v > 20).length,
    on_network: +(pts.filter((p) => p.on).length / pts.length).toFixed(3), uncertain: +(pts.filter((p) => p.unc).length / pts.length).toFixed(3),
  };
}
const out: Record<string, unknown> = {
  'raw GPS': summary(ev.flatMap((e) => (e.type === 'fix' ? [{ x: e.x, y: e.y, on: false, unc: false }] : []))),
};
for (const [name, opt] of [['HMM', {}], ['HMM+trust', { trust }]] as const) {
  const m = createMatcher(g, { platform: 'ios', ...opt });
  const pts = ev.map((e) => m.push(e)).filter((r) => r).map((r) => ({ x: r!.x, y: r!.y, on: r!.edgeKey !== null, unc: r!.state === 'uncertain' }));
  out[name] = summary(pts);
}
console.table(out);
writeFileSync(new URL('results/eval_real_c03.json', root), JSON.stringify({ note: '실제 C03(iPhone) 위치만, 걸음·기압 없음. 집계값.', pedometer_m: pedo, ...out }, null, 1));
