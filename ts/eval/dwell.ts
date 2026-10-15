// 합성 '머무름' 시나리오: 북악관 6F 복도에 거의 서 있거나 천천히 오가는 사용자, GPS 는 건물 밖으로 번진다.
// 10-14 북악관 실측(대부분 6F 에 있었음)과 같은 꼴. 지표 = 시간 중 북악관 안 비율, 북악관 6F 비율, 길 위 비율.
// 사용: tsx eval/dwell.ts '<옵션 JSON>' [trust]
import { readFileSync } from 'node:fs';
import { pointAt } from '../src/graph';
import { createMatcher, type SensorEvent } from '../src/matcher';
import { loadTrustModel } from '../src/trust';
import { g, root } from './common';

export const BLD = 'f:북악관:', TARGET = 'f:북악관:6F';
const main = process.argv[1]?.endsWith('dwell.ts');
const opts = main ? JSON.parse(process.argv[2] ?? '{}') : {};
const trust = main && process.argv[3] === 'trust' ? loadTrustModel(JSON.parse(readFileSync(new URL(opts.trustFile ?? 'models/trust_mlp.json', root), 'utf8'))) : null;

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

const edges6 = g.edges.filter((e) => g.nodes[e.from].floorKey === TARGET && g.nodes[e.to].floorKey === TARGET && !e.vertical && e.hlen > 3);
const P = { ios: { acc: [20, 60], bias: 30, pFix: 0.7 }, android: { acc: [10, 30], bias: 12, pFix: 0.85 } };

export function dwellRun(platform: 'ios' | 'android', seed: number): SensorEvent[] {
  const r = rng(seed * 7919 + (platform === 'ios' ? 1 : 2));
  const p = P[platform];
  const e = edges6[Math.floor(r.u() * edges6.length)];
  let f = r.u(), dir = 1, walkLeft = 0;
  const T = 300 + Math.floor(r.u() * 600);
  const rho = 0.99;
  let bx = p.bias * r.n(), by = p.bias * r.n(), drift = 0;
  const ev: SensorEvent[] = [];
  for (let t = 0; t < T; t++) {
    if (walkLeft <= 0 && r.u() < 1 / 60) { walkLeft = 5 + Math.floor(r.u() * 10); dir = r.u() < 0.5 ? 1 : -1; }
    if (walkLeft > 0) {
      walkLeft--;
      const nf = Math.max(0, Math.min(1, f + (dir * 1.0) / e.hlen));
      const [ax, ay] = pointAt(e, f), [cx, cy] = pointAt(e, nf);
      const hdg = (Math.atan2(cx - ax, cy - ay) * 180) / Math.PI + 6 * r.n();
      if (nf !== f) ev.push({ type: 'step', t: t + 0.3, heading: (hdg + 360) % 360 }, { type: 'step', t: t + 0.8, heading: (hdg + 360) % 360 });
      f = nf;
    }
    drift += 0.02 * r.n();
    ev.push({ type: 'baro', t: t + 0.9, h: drift + 0.1 * r.n() });
    bx = rho * bx + Math.sqrt(1 - rho * rho) * p.bias * r.n();
    by = rho * by + Math.sqrt(1 - rho * rho) * p.bias * r.n();
    if (r.u() < p.pFix) {
      const [x, y] = pointAt(e, f);
      ev.push({ type: 'fix', t: t + 1, x: x + bx + 2 * r.n(), y: y + by + 2 * r.n(), acc: p.acc[0] + r.u() * (p.acc[1] - p.acc[0]), speed: -1, course: -1 });
    }
  }
  return ev;
}

if (main) {
  for (const platform of ['ios', 'android'] as const) {
    let n = 0, inB = 0, on6 = 0, onNet = 0;
    for (let s = 0; s < 30; s++) {
      const m = createMatcher(g, { platform, trust, ...opts });
      for (const e of dwellRun(platform, s)) {
        const res = m.push(e);
        if (!res || e.type !== 'fix') continue;
        n++;
        if (res.floor?.startsWith(BLD)) inB++;
        if (res.floor === TARGET) on6++;
        if (res.edgeKey || res.areaKey) onNet++;
      }
    }
    console.log(JSON.stringify({ platform, opts, in_building: +(inB / n).toFixed(3), on_6F: +(on6 / n).toFixed(3), on_network: +(onNet / n).toFixed(3) }));
  }
}
