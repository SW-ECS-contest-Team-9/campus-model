// 평가 공용: 꾸러미·시험셋 읽기, 정답 층, 점수.
import { readFileSync } from 'node:fs';
import { buildGraph, project, segCrossesPoly } from '../src/graph';
import type { SensorEvent } from '../src/matcher';

export interface Truth { t: number; x: number; y: number; z: number; indoor: boolean; edge: string | null }
export interface Est { t: number; x: number; y: number; z: number | null; edge?: string | null; floor?: string | null; area?: string | null }
export interface Route { id: number; platform: 'ios' | 'android'; events: SensorEvent[]; truth: Truth[] }

export const root = new URL('../../', import.meta.url);
// CAMPUS_PKG=<꾸러미 경로> 로 다른 공개본(예: 백엔드 skuniv-v13, 걷는 면 있음)을 쓴다. 합성 시험셋은 data/package.json(v1) 기준이라 거기엔 쓰지 않는다.
export const pkg = JSON.parse(readFileSync(process.env.CAMPUS_PKG ?? new URL('data/package.json', root), 'utf8'));
export const g = buildGraph(pkg);
export const loadRoutes = (): Route[] => JSON.parse(readFileSync(new URL('data/synth/test.json', root), 'utf8')).routes;

const nodeBuilding = new Map<string, string | null>(pkg.nodes.map((n: any) => [n.key, n.buildingKey]));
const edgeByKey = new Map(g.edges.map((e) => [e.key, e]));
const floorsByBuilding = new Map<string, { key: string; z: number }[]>();
for (const f of pkg.floors) if (f.floorZ !== null) (floorsByBuilding.get(f.buildingKey) ?? floorsByBuilding.set(f.buildingKey, []).get(f.buildingKey)!).push({ key: f.key, z: f.floorZ });

/** 정답 층: 정답 길의 양 끝 중 높이가 가까운 노드의 층(맞춤기와 같은 규칙). */
export function truthFloor(tr: Truth): { floor: string | null; building: string | null } {
  const e = tr.edge ? edgeByKey.get(tr.edge) : undefined;
  if (!e) return { floor: null, building: null };
  const a = g.nodes[e.from], b = g.nodes[e.to];
  const n = Math.abs(a.z - tr.z) <= Math.abs(b.z - tr.z) ? a : b;
  return { floor: n.floorKey, building: nodeBuilding.get(n.key) ?? null };
}

/** 길 위 거리: 두 점을 각자 길에 투영한 뒤 그래프 최단거리(양방향 중 짧은 쪽). 길이 없으면 null. */
function alongDist(ea: string, ax: number, ay: number, eb: string, bx: number, by: number): number | null {
  const A = edgeByKey.get(ea), B = edgeByKey.get(eb);
  if (!A || !B) return null;
  const sa = project(A, ax, ay).s / (A.hlen || 1), sb = project(B, bx, by).s / (B.hlen || 1);
  if (A === B) return Math.abs(sa - sb) * A.len;
  const n = g.n;
  const ends = (E: typeof A, f: number): [number, number][] => [[E.from, f * E.len], [E.to, (1 - f) * E.len]];
  let best = Infinity;
  for (const [n1, c1] of ends(A, sa)) for (const [n2, c2] of ends(B, sb)) best = Math.min(best, c1 + Math.min(g.dist[n1 * n + n2], g.dist[n2 * n + n1]) + c2);
  return isFinite(best) ? best : null;
}

export type Acc = { along: number[]; onNet: number; estN: number; swEst: number; swTrue: number; minutes: number; err: number[]; edgeOk: number; edgeN: number; floorOk: number; floorN: number; jumps: number; outN: number; mode: 'edge' | 'z' | 'none' };
export const mk = (mode: Acc['mode']): Acc => ({ along: [], onNet: 0, estN: 0, swEst: 0, swTrue: 0, minutes: 0, err: [], edgeOk: 0, edgeN: 0, floorOk: 0, floorN: 0, jumps: 0, outN: 0, mode });

export function score(acc: Acc, truth: Truth[], est: Est[]) {
  let k = -1;
  for (const tr of truth) {
    while (k + 1 < est.length && est[k + 1].t <= tr.t + 0.5) k++;
    if (k < 0) continue;
    const e = est[k];
    acc.err.push(Math.hypot(e.x - tr.x, e.y - tr.y));
    if (acc.mode === 'edge' && tr.edge) {
      acc.edgeN++; if (e.edge === tr.edge) acc.edgeOk++;
      if (e.edge) { const d = alongDist(e.edge, e.x, e.y, tr.edge, tr.x, tr.y); if (d !== null) acc.along.push(d); }
    }
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
  // 길 위 비율(길·보행 면 안), 길 바뀜 횟수(1 Hz 표본 기준) vs 정답
  if (acc.mode === 'edge') {
    let k2 = -1, pe: string | null | undefined, pt: string | null | undefined;
    for (const tr of truth) {
      while (k2 + 1 < est.length && est[k2 + 1].t <= tr.t + 0.5) k2++;
      if (k2 < 0) continue;
      const e = est[k2];
      acc.estN++; if (e.edge || e.area) acc.onNet++;
      if (pe !== undefined && e.edge && pe && e.edge !== pe) acc.swEst++;
      if (pt !== undefined && tr.edge && pt && tr.edge !== pt) acc.swTrue++;
      if (e.edge) pe = e.edge; if (tr.edge) pt = tr.edge;
    }
    acc.minutes += truth.length / 60;
  }
}

export const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export const row = (method: string, a: Acc) => ({
  method,
  median_m: +q(a.err, 0.5).toFixed(1), p90_m: +q(a.err, 0.9).toFixed(1),
  edge_rate: a.mode === 'edge' ? +(a.edgeOk / a.edgeN).toFixed(3) : null,
  floor_rate: a.mode !== 'none' ? +(a.floorOk / a.floorN).toFixed(3) : null,
  wall_jumps_per_1000: +((1000 * a.jumps) / Math.max(1, a.outN)).toFixed(1),
  ...(a.mode === 'edge' ? {
    on_network: +(a.onNet / Math.max(1, a.estN)).toFixed(3),
    along_median_m: +q(a.along, 0.5).toFixed(1), along_p90_m: +q(a.along, 0.9).toFixed(1),
    switches_per_min: +(a.swEst / a.minutes).toFixed(2), true_switches_per_min: +(a.swTrue / a.minutes).toFixed(2),
  } : {}),
});
