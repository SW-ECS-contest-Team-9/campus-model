// 기기 안 길 맞춤(HMM, 고정 지연 Viterbi). 상태 = 길 위 점 / 보행 면 / 길 밖(바깥 열린 곳).
// 층은 길 그래프로만 바뀐다(계단·승강기·경사로 길을 지나야 함). 기압은 층에 대한 부드러운 증거.
import { buildGraph, edgesNear, inAnyFootprint, pointAt, pointInPoly, project, type Graph, type MapPackage } from './graph';
import { FeatureState } from './features';
import type { TrustModel } from './trust';

export type SensorEvent =
  | { type: 'fix'; t: number; x: number; y: number; acc: number; speed?: number; course?: number }
  | { type: 'step'; t: number; heading: number } // 도, 0 = 북, 90 = 동
  | { type: 'baro'; t: number; h: number }; // 기압 상대 높이(m)

export interface MatchResult {
  t: number; x: number; y: number; z: number;
  floor: string | null; edgeKey: string | null;
  state: 'ok' | 'uncertain';
  /** lagS 초 전 시점의 지연 보정값(고정 지연 Viterbi 역추적). 화면 표시는 x,y, 기록·분석엔 lagged. */
  lagged: { t: number; x: number; y: number; z: number; floor: string | null; edgeKey: string | null } | null;
}

export interface MatcherOptions {
  trust?: TrustModel | null; // 없으면 규칙: sigma = clamp(acc)
  strideM?: number;
  lagS?: number;
  maxCandidates?: number;
  sigmaMin?: number; sigmaMax?: number;
  radiusMin?: number; radiusMax?: number;
  offNetwork?: boolean;
  /** GPS 오차는 시간상 강하게 이어져(치우침) 점마다 독립이 아니다. 관측 점수를 이 비율로 줄인다. */
  emissionWeight?: number;
  /** 기기 종류. 믿음 모델 입력이며, 같은 정확도 값이라도 iOS GPS 를 덜 믿게 된다. */
  platform?: 'ios' | 'android';
  /** 출발점을 알면(사용자가 고른 출발지, 직전 세션 끝 등) 첫 상태를 그 근처로 묶는다. 층 판정이 크게 좋아진다. */
  start?: { x: number; y: number; z: number } | null;
}

const enum K { Edge = 0, Area = 1, Off = 2 }
interface Cand { k: K; e: number; f: number; x: number; y: number; z: number; d: number; ex?: [number, number][]; en?: [number, number][] }
interface Col { t: number; c: Cand[]; s: Float64Array; b: Int32Array; reset: boolean }

const EPS = 0.03, OUT2 = 150 * 150;

export function createMatcher(pkgOrGraph: MapPackage | Graph, options: MatcherOptions = {}) {
  const g: Graph = 'dist' in pkgOrGraph ? (pkgOrGraph as Graph) : buildGraph(pkgOrGraph as MapPackage);
  const o = {
    trust: null as TrustModel | null, strideM: 0.7, lagS: 5, maxCandidates: 60, sigmaMin: 5, sigmaMax: 50,
    radiusMin: 25, radiusMax: 120, offNetwork: true, emissionWeight: 0.3, platform: 'ios' as 'ios' | 'android', start: null as { x: number; y: number; z: number } | null, ...options,
  };
  const feats = new FeatureState(g, o.platform);
  const cols: Col[] = [];
  let stepsSeen = false, baroSeen = false;
  let baroNow = 0, baroAtUpd = 0;
  let pdrX = 0, pdrY = 0, pdrSteps = 0;
  let lastFixT = -Infinity, lastUpdT = -Infinity, lastSigma = 50;
  let last: MatchResult | null = null;

  const floorOf = (c: Cand): string | null => {
    if (c.k === K.Area) return g.areas[c.e].floorKey;
    if (c.k === K.Off) return null;
    const e = g.edges[c.e];
    const a = g.nodes[e.from], b = g.nodes[e.to];
    return Math.abs(a.z - c.z) <= Math.abs(b.z - c.z) ? a.floorKey : b.floorKey;
  };

  const exits = (c: Cand): [number, number][] => {
    if (c.ex) return c.ex;
    if (c.k === K.Edge) {
      const e = g.edges[c.e];
      c.ex = [];
      if (e.fwd) c.ex.push([e.to, (1 - c.f) * e.len]);
      if (e.back) c.ex.push([e.from, c.f * e.len]);
    } else {
      const ns = c.k === K.Area ? g.areas[c.e].nodes : g.outdoorNodes;
      c.ex = ns.map((n) => [n, Math.hypot(g.nodes[n].x - c.x, g.nodes[n].y - c.y)]);
    }
    return c.ex;
  };
  const entries = (c: Cand): [number, number][] => {
    if (c.en) return c.en;
    if (c.k === K.Edge) {
      const e = g.edges[c.e];
      c.en = [];
      if (e.fwd) c.en.push([e.from, c.f * e.len]);
      if (e.back) c.en.push([e.to, (1 - c.f) * e.len]);
    } else c.en = exits(c);
    return c.en;
  };

  const netDist = (a: Cand, b: Cand): number => {
    let best = Infinity;
    if (a.k === K.Edge && b.k === K.Edge && a.e === b.e) {
      const e = g.edges[a.e];
      if (b.f >= a.f && e.fwd) best = (b.f - a.f) * e.len;
      if (a.f >= b.f && e.back) best = Math.min(best, (a.f - b.f) * e.len);
    } else if (a.k !== K.Edge && b.k !== K.Edge) {
      best = Math.hypot(a.x - b.x, a.y - b.y);
    }
    const n = g.n;
    for (const [n1, c1] of exits(a)) {
      if (c1 >= best) continue;
      for (const [n2, c2] of entries(b)) {
        const v = c1 + g.dist[n1 * n + n2] + c2;
        if (v < best) best = v;
      }
    }
    return best;
  };

  const candidates = (x: number, y: number, sigma: number, pseudo: boolean, zPred: number | null): Cand[] => {
    const r = pseudo ? Math.max(15, 3 * sigma) : Math.min(o.radiusMax, Math.max(o.radiusMin, 3 * sigma));
    const out: Cand[] = [];
    let nearest = Infinity;
    for (const ei of edgesNear(g, x, y, r)) {
      const e = g.edges[ei];
      let f: number, d: number;
      if (e.vertical) {
        const z0 = e.pts[0][2], z1 = e.pts[e.pts.length - 1][2];
        f = zPred === null || z1 === z0 ? 0 : Math.max(0, Math.min(1, (zPred - z0) / (z1 - z0)));
        d = Math.hypot(e.pts[0][0] - x, e.pts[0][1] - y);
      } else {
        const p = project(e, x, y);
        f = p.s / e.hlen;
        d = p.d;
      }
      nearest = Math.min(nearest, d);
      if (d > r) continue;
      const [px, py, pz] = pointAt(e, f);
      out.push({ k: K.Edge, e: ei, f, x: px, y: py, z: pz, d });
    }
    out.sort((a, b) => a.d - b.d || a.e - b.e);
    out.length = Math.min(out.length, o.maxCandidates);
    const zFree = zPred ?? (last ? last.z : NaN);
    g.areas.forEach((a, ai) => {
      if (pointInPoly(x, y, a.poly)) out.push({ k: K.Area, e: ai, f: 0, x, y, z: a.z ?? zFree, d: 0 });
    });
    const offOk = o.offNetwork && !pseudo && sigma <= 15 && nearest > 20 && !inAnyFootprint(g, x, y);
    if (offOk || out.length === 0) out.push({ k: K.Off, e: -1, f: 0, x, y, z: zFree, d: 0 });
    return out;
  };

  const emission = (d: number, sigma: number) =>
    Math.log((1 - EPS) * Math.exp((-d * d) / (2 * sigma * sigma)) / (sigma * sigma) + EPS / OUT2);
  const prior = (c: Cand) => (c.k === K.Off ? -3 : c.k === K.Area ? -3 : 0);

  const update = (t: number, x: number, y: number, sigma: number, pseudo: boolean) => {
    const prev = cols[cols.length - 1];
    const dB = baroNow - baroAtUpd;
    const zPred = last && baroSeen ? last.z + dB : null;
    const c = !prev && o.start ? candidates(o.start.x, o.start.y, 10, true, o.start.z) : candidates(x, y, sigma, pseudo, zPred);
    if (!prev && o.start) for (const cc of c) cc.d = Math.hypot(cc.x - x, cc.y - y);
    if (prev && !pseudo) {
      // 직전 최선 상태를 걸음으로 민 예측점 근처 후보도 넣는다(길 위 위치가 GPS 투영에만 끌려가지 않게)
      const [px, py] = advance(prev.c[bestIdx(prev)]);
      for (const cc of candidates(px, py, 5, true, zPred)) {
        if (cc.k !== K.Edge) continue;
        cc.d = Math.hypot(cc.x - x, cc.y - y);
        c.push(cc);
      }
    }
    const s = new Float64Array(c.length);
    const b = new Int32Array(c.length).fill(-1);
    const pdr = pdrSteps * o.strideM;
    const dt = prev ? t - prev.t : 0;
    let reset = !prev;
    for (let j = 0; j < c.length; j++) {
      const em = (pseudo ? 1 : o.emissionWeight) * emission(c[j].d, sigma) + prior(c[j]);
      if (!prev) {
        const st = o.start;
        s[j] = st ? em - (Math.hypot(c[j].x - st.x, c[j].y - st.y) ** 2 + 4 * (isFinite(c[j].z) ? (c[j].z - st.z) ** 2 : 0)) / 32 : em;
        continue;
      }
      let best = -Infinity, bi = -1;
      for (let i = 0; i < prev.c.length; i++) {
        if (prev.s[i] === -Infinity) continue;
        const dn = netDist(prev.c[i], c[j]);
        if (!isFinite(dn)) continue;
        let pen: number;
        if (stepsSeen) {
          const exp = pdr + Math.abs(dB);
          pen = Math.abs(dn - exp) / (3 + 0.2 * exp);
        } else {
          pen = Math.max(0, dn - 2.5 * dt - 3) / 5 + dn / 30;
        }
        const zi = prev.c[i].z, zj = c[j].z;
        if (baroSeen && isFinite(zi) && isFinite(zj)) pen += ((zj - zi - dB) ** 2) / (2 * 0.6 * 0.6);
        const v = prev.s[i] - pen;
        if (v > best) { best = v; bi = i; }
      }
      s[j] = best + em;
      b[j] = bi;
    }
    if (prev && !s.some((v) => v > -Infinity)) {
      // 이어지는 길이 없음(일방통행 위반·끊긴 그래프): 사슬을 끊고 관측만으로 다시 시작
      for (let j = 0; j < c.length; j++) { s[j] = emission(c[j].d, sigma) + prior(c[j]); b[j] = -1; }
      reset = true;
    }
    let mx = -Infinity;
    for (const v of s) mx = Math.max(mx, v);
    for (let j = 0; j < s.length; j++) s[j] -= mx;
    cols.push({ t, c, s, b, reset });
    while (cols.length > 2 && cols[1].t < t - o.lagS - 1) cols.shift();
    pdrX = pdrY = 0; pdrSteps = 0; baroAtUpd = baroNow; lastUpdT = t;
  };

  const bestIdx = (col: Col) => {
    let bi = 0;
    for (let j = 1; j < col.s.length; j++) if (col.s[j] > col.s[bi]) bi = j;
    return bi;
  };

  const advance = (c: Cand): [number, number, number] => {
    const dB = baroNow - baroAtUpd;
    if (c.k !== K.Edge) return [c.x + pdrX, c.y + pdrY, c.z + dB];
    const e = g.edges[c.e];
    if (e.vertical || (pdrX === 0 && pdrY === 0)) return [c.x, c.y, c.z];
    const [ax, ay] = pointAt(e, Math.max(0, c.f - 0.01));
    const [bx, by] = pointAt(e, Math.min(1, c.f + 0.01));
    const L = Math.hypot(bx - ax, by - ay) || 1;
    let f = c.f + ((pdrX * (bx - ax) + pdrY * (by - ay)) / L) / e.hlen;
    if (!(e.fwd && e.back)) f = e.fwd ? Math.max(c.f, f) : Math.min(c.f, f);
    return pointAt(e, Math.max(0, Math.min(1, f)));
  };

  const result = (t: number): MatchResult | null => {
    const col = cols[cols.length - 1];
    if (!col) return null;
    const bi = bestIdx(col);
    const c = col.c[bi];
    const [x, y, z] = advance(c);
    let uncertain = col.reset || lastSigma > 40 || t - lastFixT > 30;
    for (let j = 0; j < col.c.length && !uncertain; j++)
      if (j !== bi && col.s[j] > -1.5 && Math.hypot(col.c[j].x - c.x, col.c[j].y - c.y) > 15) uncertain = true;
    // 지연 보정: 최선 경로를 lagS 초 전까지 역추적
    let li = bi, k = cols.length - 1;
    while (k > 0 && cols[k].t > t - o.lagS && cols[k].b[li] >= 0) { li = cols[k].b[li]; k--; }
    const lc = cols[k].c[li];
    return {
      t, x, y, z, floor: floorOf({ ...c, z }), edgeKey: c.k === K.Edge ? g.edges[c.e].key : null,
      state: uncertain ? 'uncertain' : 'ok',
      lagged: { t: cols[k].t, x: lc.x, y: lc.y, z: lc.z, floor: floorOf(lc), edgeKey: lc.k === K.Edge ? g.edges[lc.e].key : null },
    };
  };

  function push(ev: SensorEvent): MatchResult | null {
    if (ev.type === 'baro') {
      if (!baroSeen) { baroSeen = true; baroAtUpd = ev.h; }
      baroNow = ev.h;
      feats.baroSample(ev.t, ev.h);
      if (last && Math.abs(baroNow - baroAtUpd) > 2.5 && ev.t - lastUpdT >= 2) update(ev.t, last.x, last.y, 8, true);
    } else if (ev.type === 'step') {
      stepsSeen = true;
      feats.step(ev.t);
      const h = (ev.heading * Math.PI) / 180;
      pdrX += o.strideM * Math.sin(h);
      pdrY += o.strideM * Math.cos(h);
      pdrSteps++;
      if (last && ev.t - lastFixT > 3 && pdrSteps >= 6) {
        const c = cols[cols.length - 1].c[bestIdx(cols[cols.length - 1])];
        const [x, y] = advance(c);
        update(ev.t, x, y, 6, true);
      }
    } else {
      const f = feats.fix(ev.t, ev.x, ev.y, ev.acc, ev.speed ?? -1, ev.course ?? -1);
      const raw = o.trust ? o.trust.sigma(f) : ev.acc;
      const sigma = Math.max(o.sigmaMin, Math.min(o.sigmaMax, raw));
      lastSigma = sigma;
      lastFixT = ev.t;
      update(ev.t, ev.x, ev.y, sigma, false);
    }
    const r = result(ev.t);
    if (r) last = r;
    return r;
  }

  return { push, graph: g };
}
