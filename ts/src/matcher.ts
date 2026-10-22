// 기기 안 길 맞춤(HMM, 고정 지연 Viterbi). 상태 = 길 위 점 / 보행 면 / 길 밖(바깥 열린 곳).
// 층은 길 그래프로만 바뀐다(계단·승강기·경사로 길을 지나야 함). 기압은 층에 대한 부드러운 증거.
import { buildGraph, edgesNear, footprintDist, inAnyFootprint, pointAt, pointInPoly, project, type Graph, type MapPackage } from './graph';
import { FeatureState } from './features';
import type { TrustModel } from './trust';

export type SensorEvent =
  // alt = GPS 높이(정표고 m, 지도 z 와 같은 기준), vacc = 수직 정확도(m). 없으면 생략.
  | { type: 'fix'; t: number; x: number; y: number; acc: number; speed?: number; course?: number; alt?: number; vacc?: number }
  | { type: 'step'; t: number; heading: number } // 도, 0 = 북, 90 = 동
  | { type: 'baro'; t: number; h: number }; // 기압 상대 높이(m)

export interface MatchResult {
  t: number; x: number; y: number; z: number;
  floor: string | null; edgeKey: string | null;
  /** 보행 면 안이면 그 면 키. */
  areaKey: string | null;
  /** 실내 길이 없는 건물 안 상태면 그 건물 키(층은 floor). edgeKey·areaKey·buildingKey 가 모두 null 이면 길 밖 상태. */
  buildingKey: string | null;
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
  /** 절대 높이 기준: 확실히 바깥 길 위일 때 (길 높이 − 기압)으로 기압 영점을 잡고, 이후 후보 높이를 절대값으로 비교한다. */
  anchor?: boolean;
  /** 절대 높이 비교의 표준편차(m). */
  anchorSigma?: number;
  /** 절대 높이 벌점 상한(기압 표류·영점 오류 때 길 없이 층을 건너뛰지 않게). */
  anchorCap?: number;
  /** 기준 표본 조건: GPS sigma 이하(m), 건물 외곽선에서 이만큼 떨어짐(m). 받아들인 영점과 이만큼 넘게 다르면 버림(m). */
  anchorMaxSigma?: number; anchorFootprintM?: number; anchorReject?: number; anchorAgree?: number;
  /** 전이 점수에 걸음 벡터(걸음 수 × 보폭, 방향)와 상태 간 변위의 차이를 넣는다. */
  pdrVector?: boolean; pdrVecSd?: number;
  /** 길 밖 상태를 허용하기 전 필요한 연속 '아주 좋은 GPS + 길에서 25 m 넘게' 위치 수. */
  offSustain?: number;
  /** 다른 길(또는 면)로 옮길 때 전이 벌점: 지금 길을 따라 미끄러지게 한다. */
  switchPenalty?: number;
  /** GPS sigma 가 10→30 m 로 나빠질수록 건물 안(층 있는) 후보에 더하는 점수(최대값). */
  indoorPull?: number;
  /** 믿음 모델을 sigma 를 키울 때만 쓴다(보고 정확도보다 더 믿지 않음). */
  trustGate?: boolean;
  /** 층별 사전 점수(log). 기압 영점을 아직 못 잡았을 때만 쓴다. 자주 머무는 층·수집 기준점·직전 세션 층에서 채운다. */
  floorPrior?: Record<string, number> | null;
  /** 사용자가 고른 층(기압계 없는 기기용). 기압 표본이 한 번도 안 오면 그 건물 안에서는 이 층 후보만 쓴다. 실행 중 setFloor 로 바꿀 수 있다. */
  userFloor?: string | null;
  /** 실내 길이 없는 건물(예: 한림관)도 상태로 둔다. 사전 점수(log)는 bareBuildingPrior. */
  bareBuildings?: boolean; bareBuildingPrior?: number;
  /** GPS 높이를 절대 높이 증거로 쓰는 수직 정확도 상한(m). 0 이면 끔. 10-14 실측: 안드로이드(S21)는 실내에서도 vacc 1~2 m·층 높이와 1 m 안, iPhone 은 vacc 3~6 m 여도 20~35 m 틀려 끔. */
  gpsAltMaxVacc?: number;
}

const enum K { Edge = 0, Area = 1, Off = 2, Bldg = 3 }
interface Cand { k: K; e: number; f: number; x: number; y: number; z: number; d: number; ex?: [number, number][]; en?: [number, number][] }
interface Col { t: number; c: Cand[]; s: Float64Array; b: Int32Array; reset: boolean }

const EPS = 0.03, OUT2 = 150 * 150;

export function createMatcher(pkgOrGraph: MapPackage | Graph, options: MatcherOptions = {}) {
  const g: Graph = 'dist' in pkgOrGraph ? (pkgOrGraph as Graph) : buildGraph(pkgOrGraph as MapPackage);
  const o = {
    trust: null as TrustModel | null, strideM: 0.7, lagS: 5, maxCandidates: 60, sigmaMin: 5, sigmaMax: 50,
    radiusMin: 25, radiusMax: 120, offNetwork: true, emissionWeight: 0.3, platform: 'ios' as 'ios' | 'android', start: null as { x: number; y: number; z: number } | null,
    anchor: true, anchorSigma: 1.0, anchorCap: 8, anchorMaxSigma: 10, anchorFootprintM: 8, anchorReject: 3, anchorAgree: 1.5, pdrVector: true, pdrVecSd: 2, offSustain: 10, switchPenalty: 0, trustGate: false, indoorPull: 1, floorPrior: null as Record<string, number> | null, userFloor: null as string | null, bareBuildings: true, bareBuildingPrior: -1, gpsAltMaxVacc: 0, ...options,
  };
  const feats = new FeatureState(g, o.platform);
  const cols: Col[] = [];
  let stepsSeen = false, baroSeen = false;
  let baroNow = 0, baroAtUpd = 0;
  let pdrX = 0, pdrY = 0, pdrSteps = 0;
  let lastFixT = -Infinity, lastUpdT = -Infinity, lastSigma = 50;
  let last: MatchResult | null = null;
  // 기압 영점: 절대 높이 = 기압 + off. offN = 받아들인 기준 표본 수(0 이면 모름)
  let off = 0, offN = 0, offRun = 0;
  let pend: number[] = []; // 기준을 처음 잡기 전 모으는 표본
  const anchorEdge = (c: Cand) => {
    if (c.k !== K.Edge) return false;
    const e = g.edges[c.e];
    return g.nodes[e.from].outdoor && g.nodes[e.to].outdoor && e.kind !== 'stairs' && e.kind !== 'elevator';
  };
  const anchorSample = (s: number) => {
    if (offN === 0) {
      // 처음엔 연속 표본 3개가 1.5 m 안에서 맞아야 받아들인다
      pend.push(s);
      if (pend.length > 3) pend.shift();
      if (pend.length < 3 || Math.max(...pend) - Math.min(...pend) > 1.5) return;
      off = (pend[0] + pend[1] + pend[2]) / 3; offN = 3; pend = [];
      return;
    }
    if (Math.abs(s - off) > o.anchorReject) return; // 튀는 표본(잘못 맞춘 바깥 길)은 버린다
    offN++;
    off += (s - off) / Math.min(offN, 10);
  };

  const floorOf = (c: Cand): string | null => {
    if (c.k === K.Area) return g.areas[c.e].floorKey;
    if (c.k === K.Off) return null;
    if (c.k === K.Bldg) {
      let best = g.bareBuildings[c.e].floors[0];
      for (const f of g.bareBuildings[c.e].floors) if (Math.abs(f.z - c.z) < Math.abs(best.z - c.z)) best = f;
      return isFinite(c.z) ? best.key : null;
    }
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
    } else if ((a.k !== K.Edge && b.k !== K.Edge) || a.k === K.Bldg || b.k === K.Bldg) {
      // 실내 길 없는 건물은 문이 모델에 없으므로 바로 옆 길에서 곧장 들어간다고 본다
      best = Math.hypot(a.x - b.x, a.y - b.y);
      if (a.k === K.Bldg || b.k === K.Bldg) return best;
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
    const r0 = pseudo ? Math.max(15, 3 * sigma) : Math.min(o.radiusMax, Math.max(o.radiusMin, 3 * sigma));
    const out: Cand[] = [];
    let nearest = Infinity;
    // 반경 안에 길이 없으면 넓혀 가며 찾는다(길로 끌어당김: 길 밖 상태는 마지막 수단)
    for (const r of [r0, o.radiusMax, 300]) {
      if (r < r0 || out.length) break;
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
      if (pseudo) break;
    }
    if (o.userFloor && !baroSeen) {
      // 기압계 없음: 고른 층의 건물 안에서는 그 층(과 층 없는 바깥) 후보만 남긴다
      const bp = o.userFloor.slice(0, o.userFloor.lastIndexOf(':') + 1);
      for (let k = out.length - 1; k >= 0; k--) {
        const fk = floorOf(out[k]);
        if (fk && fk !== o.userFloor && fk.startsWith(bp)) out.splice(k, 1);
      }
    }
    out.sort((a, b) => a.d - b.d || a.e - b.e);
    out.length = Math.min(out.length, o.maxCandidates);
    const zFree = zPred ?? (last ? last.z : NaN);
    g.areas.forEach((a, ai) => {
      if (pointInPoly(x, y, a.poly)) out.push({ k: K.Area, e: ai, f: 0, x, y, z: a.z ?? zFree, d: 0 });
    });
    // 실내 길이 없는 건물: 관측이 외곽선 안이면 건물 자체를 상태로 둔다(높이는 기압으로 이어 감 → 층)
    if (o.bareBuildings) {
      const zA = o.anchor && baroSeen && offN > 0 ? baroNow + off : zFree;
      g.bareBuildings.forEach((bb, bi) => {
        if (pointInPoly(x, y, bb.poly)) out.push({ k: K.Bldg, e: bi, f: 0, x, y, z: zA, d: 0 });
      });
    }
    // 길 밖 상태는 GPS 가 아주 좋고 모든 길에서 멀리 떨어진 상태가 offSustain 번 이어졌을 때만(그 전엔 길로 끌어당긴다)
    if (!pseudo) offRun = sigma <= 8 && nearest > 25 && !inAnyFootprint(g, x, y) ? offRun + 1 : 0;
    const offOk = o.offNetwork && !pseudo && offRun >= o.offSustain;
    if (offOk || out.length === 0) out.push({ k: K.Off, e: -1, f: 0, x, y, z: zFree, d: 0 });
    return out;
  };

  const emission = (d: number, sigma: number) =>
    Math.log((1 - EPS) * Math.exp((-d * d) / (2 * sigma * sigma)) / (sigma * sigma) + EPS / OUT2);
  const prior = (c: Cand) => (c.k === K.Off ? -3 : c.k === K.Area ? -3 : c.k === K.Bldg ? o.bareBuildingPrior : 0);

  const update = (t: number, x: number, y: number, sigma: number, pseudo: boolean, gpsZ = NaN, gpsZSd = 1) => {
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
    // 절대 높이: 믿을 만한 GPS 높이가 있으면 그것, 없으면 기압 + 영점
    const gpsAbs = isFinite(gpsZ);
    const zAbs = gpsAbs ? gpsZ : o.anchor && baroSeen && offN > 0 ? baroNow + off : NaN;
    const zSd = gpsAbs ? Math.max(o.anchorSigma, gpsZSd) : o.anchorSigma;
    for (let j = 0; j < c.length; j++) {
      let em = (pseudo ? 1 : o.emissionWeight) * emission(c[j].d, sigma) + prior(c[j]);
      if (c[j].k !== K.Off && isFinite(zAbs) && isFinite(c[j].z)) em -= Math.min(o.anchorCap, (c[j].z - zAbs) ** 2 / (2 * zSd ** 2));
      if (o.indoorPull || o.floorPrior) {
        const fk = floorOf(c[j]);
        // GPS 가 나쁠수록(실내 꼴) 건물 안 길 쪽으로 끌어당김
        if (fk && o.indoorPull && !pseudo) em += o.indoorPull * Math.max(0, Math.min(1, (sigma - 10) / 20));
        if (fk && o.floorPrior && !(isFinite(zAbs))) em += o.floorPrior[fk] ?? 0;
      }
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
          // 걸음 없이 길 위로 멀리 옮겨 가는 전이는 없다(기압만 바뀐 경우 층을 길 없이 건너뛰지 않게)
          if (pdrSteps === 0 && dn > exp + 8) continue;
          pen = Math.abs(dn - exp) / (3 + 0.2 * exp);
          if (o.pdrVector) {
            // 걸음 방향까지: 두 상태 사이 수평 변위 vs 걸음 벡터 합
            const ex = c[j].x - prev.c[i].x - pdrX, ey = c[j].y - prev.c[i].y - pdrY;
            pen += Math.hypot(ex, ey) / (o.pdrVecSd + 0.15 * pdr);
          }
        } else {
          pen = Math.max(0, dn - 2.5 * dt - 3) / 5 + dn / 30;
        }
        if (o.switchPenalty && (prev.c[i].k !== c[j].k || prev.c[i].e !== c[j].e)) pen += o.switchPenalty;
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
    if (o.anchor && baroSeen && !pseudo && sigma <= o.anchorMaxSigma && footprintDist(g, x, y) >= o.anchorFootprintM) {
      // 최선 상태가 바깥 평지 길이고, GPS 가 그 자리와 맞고(1.5 sigma), 15 m 넘게 떨어진 경쟁 상태가 없을 때만
      const col = cols[cols.length - 1], bi = bestIdx(col), bc = c[bi];
      let ok = anchorEdge(bc) && bc.d <= o.anchorAgree * sigma;
      for (let j = 0; j < c.length && ok; j++)
        if (j !== bi && col.s[j] > -3 && Math.hypot(c[j].x - bc.x, c[j].y - bc.y) > 15) ok = false;
      if (ok) anchorSample(bc.z - baroNow);
    }
    if (gpsAbs && baroSeen) anchorSample(gpsZ - baroNow); // GPS 높이로 기압 영점도 잡는다(GPS 없는 구간용)
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
      t, x, y, z, floor: floorOf({ ...c, z }), edgeKey: c.k === K.Edge ? g.edges[c.e].key : null, areaKey: c.k === K.Area ? g.areas[c.e].key : null, buildingKey: c.k === K.Bldg ? g.bareBuildings[c.e].key : null,
      state: uncertain ? 'uncertain' : 'ok',
      lagged: { t: cols[k].t, x: lc.x, y: lc.y, z: lc.z, floor: floorOf(lc), edgeKey: lc.k === K.Edge ? g.edges[lc.e].key : null },
    };
  };

  function push(ev: SensorEvent): MatchResult | null {
    if (ev.type === 'baro') {
      if (!baroSeen) {
        baroSeen = true; baroAtUpd = ev.h;
        if (o.start) { off = o.start.z - ev.h; offN = 10; }
      }
      baroNow = ev.h;
      feats.baroSample(ev.t, ev.h);
      if (last && Math.abs(baroNow - baroAtUpd) > 2.5 && ev.t - lastUpdT >= 2) update(ev.t, last.x, last.y, 8, true);
    } else if (ev.type === 'step') {
      stepsSeen = true;
      feats.step(ev.t, ev.heading);
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
      const raw = o.trust ? (o.trustGate ? Math.max(ev.acc, o.trust.sigma(f)) : o.trust.sigma(f)) : ev.acc;
      const sigma = Math.max(o.sigmaMin, Math.min(o.sigmaMax, raw));
      lastSigma = sigma;
      lastFixT = ev.t;
      const altOk = o.gpsAltMaxVacc > 0 && ev.alt !== undefined && ev.vacc !== undefined && ev.vacc > 0 && ev.vacc <= o.gpsAltMaxVacc;
      update(ev.t, ev.x, ev.y, sigma, false, altOk ? ev.alt! : NaN, altOk ? ev.vacc! : 1);
    }
    const r = result(ev.t);
    if (r) last = r;
    return r;
  }

  /** 기압 영점(절대 높이 = 기압 + off). 기준을 아직 못 잡았으면 null. */
  const baroOffset = () => (offN > 0 ? off : null);
  /** 사용자가 층을 고르면 부른다(기압계 없는 기기에서 층 판정에 쓰임). null 이면 해제. */
  const setFloor = (floorKey: string | null) => { o.userFloor = floorKey; };
  return { push, graph: g, baroOffset, setFloor };
}
