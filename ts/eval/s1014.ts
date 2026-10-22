// 10-14 북악관 세션: 세션 단위 건물·층 귀속(정답 = 대부분 북악관 6F, 사용자 확인). 집계값만 출력·저장.
// 준비: uv run python -m campus_model.real_events --dir <s1014 원시 폴더> <변환 폴더(저장소 밖)>
//       라벨 파일(저장소 밖): { "<파일 이름>": { platform: 'ios'|'android', label: 'stay6F'|'moved', uncertain: bool } }
// 사용: npx tsx eval/s1014.ts <변환 폴더> <라벨.json> [결과 이름]   폴더가 없거나 비면 건너뛴다.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMatcher, type MatcherOptions, type SensorEvent } from '../src/matcher';
import { pointInPoly } from '../src/graph';
import { loadTrustModel } from '../src/trust';
import { g, pkg, q, root } from './common';

const BLD = 'f:북악관:', TARGET = 'f:북악관:6F';
const [dir, labelPath, outName = 'eval_s1014'] = process.argv.slice(2);
const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
if (!files.length || !labelPath || !existsSync(labelPath)) {
  console.log('10-14 세션 자료 없음: 건너뜀', dir ?? '');
  process.exit(0);
}
type Label = { platform: 'ios' | 'android'; label: 'stay6F' | 'moved'; uncertain: boolean };
const labels: Record<string, Label> = JSON.parse(readFileSync(labelPath, 'utf8'));
const trustV2 = loadTrustModel(JSON.parse(readFileSync(new URL('models/trust_mlp_v2.json', root), 'utf8')));

const fp: [number, number][] = pkg.buildings.find((b: any) => b.key === 'b:북악관').footprint;
function distFp(x: number, y: number) {
  if (pointInPoly(x, y, fp)) return 0;
  let best = Infinity;
  for (let i = 0; i < fp.length; i++) {
    const [ax, ay] = fp[(i + fp.length - 1) % fp.length], [bx, by] = fp[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

// 기기별 기본값(createDefaultMatcher 와 같음) + 실험 옵션
const methods: [string, (p: 'ios' | 'android') => MatcherOptions][] = [
  ['v2 default', (p) => ({ platform: p, trust: p === 'android' ? trustV2 : null })],
  ['v2 + floorPrior(6F)', (p) => ({ platform: p, trust: p === 'android' ? trustV2 : null, floorPrior: { [TARGET]: 1 } })],
];

interface Per { file: string; platform: string; label: string; uncertain: boolean; n: number; inB: number; on6: number; flips: number; flipsPerMin: number; dRaw: number; dMatch: number }
const out: Record<string, unknown> = {};
for (const [name, opt] of methods) {
  const per: Per[] = [];
  for (const f of files) {
    const lb = labels[f];
    if (!lb) continue;
    const ev: SensorEvent[] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const m = createMatcher(g, opt(lb.platform));
    let n = 0, inB = 0, on6 = 0, flips = 0, prev: string | null | undefined;
    const dRaw: number[] = [], dMatch: number[] = [];
    let t0 = NaN, t1 = NaN;
    for (const e of ev) {
      const r = m.push(e);
      if (!r || e.type !== 'fix') continue;
      n++;
      if (isNaN(t0)) t0 = e.t;
      t1 = e.t;
      if (r.floor?.startsWith(BLD)) inB++;
      if (r.floor === TARGET) on6++;
      if (prev !== undefined && r.floor !== prev) flips++;
      prev = r.floor;
      dRaw.push(distFp(e.x, e.y));
      dMatch.push(distFp(r.x, r.y));
    }
    if (!n) continue;
    const min = Math.max(1, t1 - t0) / 60;
    per.push({ file: f.slice(0, 8), platform: lb.platform, label: lb.label, uncertain: lb.uncertain, n, inB: inB / n, on6: on6 / n, flips, flipsPerMin: flips / min, dRaw: q(dRaw, 0.5), dMatch: q(dMatch, 0.5) });
  }
  const agg = (ps: Per[]) => {
    const N = ps.reduce((a, p) => a + p.n, 0);
    const r3 = (v: number) => +v.toFixed(3);
    return {
      sessions: ps.length, fixes: N,
      in_bugak_median: r3(q(ps.map((p) => p.inB), 0.5)), in_bugak_pooled: r3(ps.reduce((a, p) => a + p.inB * p.n, 0) / Math.max(1, N)),
      on_6F_median: r3(q(ps.map((p) => p.on6), 0.5)), on_6F_pooled: r3(ps.reduce((a, p) => a + p.on6 * p.n, 0) / Math.max(1, N)),
      sessions_mostly_6F: ps.filter((p) => p.on6 >= 0.5).length,
      floor_flips_total: ps.reduce((a, p) => a + p.flips, 0), floor_flips_per_min_median: +q(ps.map((p) => p.flipsPerMin), 0.5).toFixed(2),
      raw_dist_median_m: +q(ps.map((p) => p.dRaw), 0.5).toFixed(1), matched_dist_median_m: +q(ps.map((p) => p.dMatch), 0.5).toFixed(1),
    };
  };
  const groups: Record<string, unknown> = {};
  for (const plat of ['ios', 'android']) {
    groups[`${plat} stay6F`] = agg(per.filter((p) => p.platform === plat && p.label === 'stay6F'));
    groups[`${plat} stay6F (10+ fixes)`] = agg(per.filter((p) => p.platform === plat && p.label === 'stay6F' && p.n >= 10));
    groups[`${plat} moved`] = agg(per.filter((p) => p.platform === plat && p.label === 'moved'));
  }
  console.log(`\n== ${name}`);
  console.table(groups);
  out[name] = { groups, sessions: per.map((p) => ({ ...p, inB: +p.inB.toFixed(3), on6: +p.on6.toFixed(3), flipsPerMin: +p.flipsPerMin.toFixed(2), dRaw: +p.dRaw.toFixed(1), dMatch: +p.dMatch.toFixed(1) })) };
}
writeFileSync(new URL(`results/${outName}.json`, root), JSON.stringify({ note: '10-14 북악관 세션, 집계값만(좌표 없음). 정답: moved 6개 빼고 북악관 6F. 기압·걸음은 서버 융합 대용.', ...out }, null, 1));
