// 실험 한 줄: 같은 합성 시험셋에서 맞춤기 한 설정만 돌린다.
// 사용: tsx eval/experiment.ts <ios|android> '<옵션 JSON>' [trust]
import { readFileSync } from 'node:fs';
import { createMatcher } from '../src/matcher';
import { loadTrustModel } from '../src/trust';
import { g, loadRoutes, mk, root, row, score, q, type Est } from './common';

const platform = process.argv[2] as 'ios' | 'android';
const opts = JSON.parse(process.argv[3] ?? '{}');
const useTrust = process.argv[4] === 'trust';
const trust = useTrust ? loadTrustModel(JSON.parse(readFileSync(new URL(opts.trustFile ?? 'models/trust_mlp.json', root), 'utf8'))) : null;
const acc = mk('edge');
const lat: number[] = [];
for (const r of loadRoutes().filter((r) => r.platform === platform)) {
  const m = createMatcher(g, { platform, trust, ...opts });
  const est: Est[] = [];
  for (const e of r.events) {
    const s = performance.now();
    const res = m.push(e);
    if (e.type === 'fix') lat.push(performance.now() - s);
    if (res) est.push({ t: res.t, x: res.x, y: res.y, z: res.z, edge: res.edgeKey, floor: res.floor, area: res.areaKey });
  }
  score(acc, r.truth, est);
}
console.log(JSON.stringify({ platform, opts, trust: useTrust, ...row('x', acc), p99_ms: +q(lat, 0.99).toFixed(2) }));
