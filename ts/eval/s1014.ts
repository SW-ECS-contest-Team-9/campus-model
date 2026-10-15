// 10-14 북악관 세션: 세션 단위 건물·층 귀속(정답 = 대부분 북악관 6F, 사용자 확인). 집계값만 출력.
// 준비: uv run python -m campus_model.real_events --dir <s1014 폴더> <변환 폴더(저장소 밖)>
// 사용: npx tsx eval/s1014.ts <변환 폴더> [ios|android]   폴더가 없거나 비면 건너뛴다.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMatcher, type SensorEvent } from '../src/matcher';
import { createMatcher as createV1 } from './v1/matcher';
import { loadTrustModel } from '../src/trust';
import { g, q, root } from './common';

const BLD = 'f:북악관:', TARGET = 'f:북악관:6F';
const dir = process.argv[2];
const platform = (process.argv[3] ?? 'ios') as 'ios' | 'android';
const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
if (!files.length) {
  console.log('10-14 세션 자료 없음: 건너뜀', dir ?? '');
  process.exit(0);
}
const load = (f: string) => loadTrustModel(JSON.parse(readFileSync(new URL(f, root), 'utf8')));
const makers: [string, () => any][] = [
  ['v1 HMM+trust', () => createV1(g, { platform, trust: load('models/trust_mlp.json') })],
  ['v2 default', () => createMatcher(g, { platform, trust: platform === 'android' ? load('models/trust_mlp_v2.json') : null })],
  ['v2 + floorPrior(6F)', () => createMatcher(g, { platform, trust: platform === 'android' ? load('models/trust_mlp_v2.json') : null, floorPrior: { [TARGET]: 1 } })],
];
const res: Record<string, unknown> = {};
for (const [name, make] of makers) {
  const per: { inB: number; on6: number }[] = [];
  for (const f of files) {
    const ev: SensorEvent[] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const m = make();
    let n = 0, inB = 0, on6 = 0;
    for (const e of ev) {
      const r = m.push(e);
      if (!r || e.type !== 'fix') continue;
      n++;
      if (r.floor?.startsWith(BLD)) inB++;
      if (r.floor === TARGET) on6++;
    }
    if (n) per.push({ inB: inB / n, on6: on6 / n });
  }
  res[name] = {
    sessions: per.length,
    in_building_median: +q(per.map((p) => p.inB), 0.5).toFixed(3),
    on_6F_median: +q(per.map((p) => p.on6), 0.5).toFixed(3),
    sessions_mostly_6F: per.filter((p) => p.on6 >= 0.5).length,
  };
}
console.table(res);
writeFileSync(new URL('results/eval_s1014.json', root), JSON.stringify({ note: '10-14 북악관 세션, 집계값만. 정답: 5~6개 빼고 북악관 6F.', platform, ...res }, null, 1));
