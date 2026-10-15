// 지도 꾸러미(map-package-v1) → 맞춤용 길 그래프. 네트워크(방향 있는) 최단거리를 노드 쌍마다 미리 계산한다.

export type XYZ = [number, number, number];

export interface MapPackage {
  buildings: { key: string; footprint: [number, number][] | null }[];
  floors: { key: string; buildingKey: string; floorZ: number | null }[];
  nodes: { key: string; location: 'outdoor' | 'indoor'; floorKey: string | null; x: number; y: number; z: number }[];
  edges: {
    key: string; from: string; to: string; kind: string;
    direction: 'both' | 'forward' | 'backward'; pedestrianAccess: string; lengthM: number; geometry: XYZ[];
  }[];
  walkAreas: { key: string; floorKey: string | null; polygon: [number, number][]; z: number | null }[];
  walkAreaNodes: { areaKey: string; nodeKey: string }[];
}

export interface GEdge {
  key: string; i: number; from: number; to: number; kind: string;
  fwd: boolean; back: boolean; len: number; pts: XYZ[]; cum: number[]; hlen: number; vertical: boolean;
  minx: number; miny: number; maxx: number; maxy: number;
}

export interface GNode { key: string; x: number; y: number; z: number; outdoor: boolean; floorKey: string | null }

export interface GArea { key: string; poly: [number, number][]; z: number | null; floorKey: string | null; nodes: number[] }

export interface Graph {
  nodes: GNode[];
  edges: GEdge[];
  areas: GArea[];
  outdoorNodes: number[];
  dist: Float64Array; // n*n, dist[a*n+b] = a→b
  n: number;
  footprints: [number, number][][];
  cell: number;
  grid: Map<string, number[]>;
}

const CELL = 20;

export function buildGraph(pkg: MapPackage): Graph {
  const idx = new Map<string, number>();
  const nodes: GNode[] = pkg.nodes.map((n, i) => {
    idx.set(n.key, i);
    return { key: n.key, x: n.x, y: n.y, z: n.z, outdoor: n.location === 'outdoor', floorKey: n.floorKey };
  });
  const edges: GEdge[] = [];
  for (const e of pkg.edges) {
    if (e.pedestrianAccess === 'prohibited') continue;
    const pts = e.geometry;
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const hlen = cum[cum.length - 1];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    edges.push({
      key: e.key, i: edges.length, from: idx.get(e.from)!, to: idx.get(e.to)!, kind: e.kind,
      fwd: e.direction !== 'backward', back: e.direction !== 'forward', len: e.lengthM, pts, cum, hlen,
      vertical: hlen < 1,
      minx: Math.min(...xs), miny: Math.min(...ys), maxx: Math.max(...xs), maxy: Math.max(...ys),
    });
  }
  const n = nodes.length;
  const dist = new Float64Array(n * n).fill(Infinity);
  const adj: [number, number][][] = nodes.map(() => []);
  for (const e of edges) {
    if (e.fwd) adj[e.from].push([e.to, e.len]);
    if (e.back) adj[e.to].push([e.from, e.len]);
  }
  for (let s = 0; s < n; s++) {
    // n 이 수백이라 단순 O(n^2) 다익스트라로 충분
    const d = dist.subarray(s * n, s * n + n);
    const done = new Uint8Array(n);
    d[s] = 0;
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let k = 0; k < n; k++) if (!done[k] && d[k] < best) { best = d[k]; u = k; }
      if (u < 0) break;
      done[u] = 1;
      for (const [v, w] of adj[u]) if (best + w < d[v]) d[v] = best + w;
    }
  }
  const areaNodes = new Map<string, number[]>();
  for (const wn of pkg.walkAreaNodes) {
    const k = idx.get(wn.nodeKey);
    if (k !== undefined) (areaNodes.get(wn.areaKey) ?? areaNodes.set(wn.areaKey, []).get(wn.areaKey)!).push(k);
  }
  const areas = pkg.walkAreas.map((a) => ({ key: a.key, poly: a.polygon, z: a.z, floorKey: a.floorKey, nodes: areaNodes.get(a.key) ?? [] }));
  const grid = new Map<string, number[]>();
  for (const e of edges) {
    for (let gx = Math.floor(e.minx / CELL); gx <= Math.floor(e.maxx / CELL); gx++)
      for (let gy = Math.floor(e.miny / CELL); gy <= Math.floor(e.maxy / CELL); gy++) {
        const k = gx + ',' + gy;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(e.i);
      }
  }
  return {
    nodes, edges, areas, n, dist, grid, cell: CELL,
    outdoorNodes: nodes.map((nd, i) => (nd.outdoor ? i : -1)).filter((i) => i >= 0),
    footprints: pkg.buildings.filter((b) => b.footprint).map((b) => b.footprint!),
  };
}

export function edgesNear(g: Graph, x: number, y: number, r: number): number[] {
  const out = new Set<number>();
  for (let gx = Math.floor((x - r) / g.cell); gx <= Math.floor((x + r) / g.cell); gx++)
    for (let gy = Math.floor((y - r) / g.cell); gy <= Math.floor((y + r) / g.cell); gy++)
      for (const e of g.grid.get(gx + ',' + gy) ?? []) out.add(e);
  return [...out].sort((a, b) => a - b);
}

/** 수평 투영: 가장 가까운 점의 수평 누적거리 s 와 거리 d. */
export function project(e: GEdge, x: number, y: number): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let k = 1; k < e.pts.length; k++) {
    const [ax, ay] = e.pts[k - 1];
    const [bx, by] = e.pts[k];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(x - px, y - py);
    if (d < best.d) best = { s: e.cum[k - 1] + t * (e.cum[k] - e.cum[k - 1]), d };
  }
  return best;
}

/** 길 위 비율 f(0=from,1=to) 의 좌표. 수직 길(승강기)은 z 만 바뀐다. */
export function pointAt(e: GEdge, f: number): XYZ {
  const p = e.pts;
  if (e.vertical) {
    const a = p[0], b = p[p.length - 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  const s = f * e.hlen;
  for (let k = 1; k < p.length; k++) {
    if (s <= e.cum[k] || k === p.length - 1) {
      const seg = e.cum[k] - e.cum[k - 1];
      const t = seg > 0 ? Math.max(0, Math.min(1, (s - e.cum[k - 1]) / seg)) : 0;
      return [p[k - 1][0] + (p[k][0] - p[k - 1][0]) * t, p[k - 1][1] + (p[k][1] - p[k - 1][1]) * t, p[k - 1][2] + (p[k][2] - p[k - 1][2]) * t];
    }
  }
  return p[p.length - 1];
}

export function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inAnyFootprint(g: { footprints: [number, number][][] }, x: number, y: number): boolean {
  return g.footprints.some((fp) => pointInPoly(x, y, fp));
}

/** 점에서 가장 가까운 건물 외곽선까지 거리(안이면 0). */
export function footprintDist(g: { footprints: [number, number][][] }, x: number, y: number): number {
  let best = Infinity;
  for (const fp of g.footprints) {
    if (pointInPoly(x, y, fp)) return 0;
    for (let i = 0, j = fp.length - 1; i < fp.length; j = i++) {
      const [ax, ay] = fp[j], [bx, by] = fp[i];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
  }
  return best;
}

/** 선분이 다각형 경계를 가로지르는가. */
export function segCrossesPoly(ax: number, ay: number, bx: number, by: number, poly: [number, number][]): boolean {
  const cr = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [cx, cy] = poly[j];
    const [dx, dy] = poly[i];
    const d1 = cr(ax, ay, bx, by, cx, cy), d2 = cr(ax, ay, bx, by, dx, dy);
    const d3 = cr(cx, cy, dx, dy, ax, ay), d4 = cr(cx, cy, dx, dy, bx, by);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}
