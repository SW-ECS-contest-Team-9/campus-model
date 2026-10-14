// 기기에서 잴 수 있는 벤치마크(Hermes 에서 돎: Node 전용 API 없음).
// 앱 개발 빌드에서 불러 console.log 로 찍고 `adb logcat -s ReactNativeJS` 로 본다.
import { createMatcher, type MatcherOptions, type SensorEvent } from './matcher';
import { buildGraph, type MapPackage } from './graph';

const now = (): number => (globalThis as any).performance?.now?.() ?? Date.now();

/** 꾸러미의 길을 따라 합성 이동(1 Hz GPS + 걸음 + 기압)을 만들어 push 시간을 잰다. */
export function benchmarkMatcher(pkg: MapPackage, options: MatcherOptions = {}, fixes = 600) {
  const t0 = now();
  const g = buildGraph(pkg);
  const buildMs = now() - t0;
  const m = createMatcher(g, options);
  const times: number[] = [];
  let t = 0, k = 0;
  // 길을 차례로 지나며 GPS 를 ±10 m 결정적 잡음으로 흔든다
  while (times.length < fixes) {
    const e = g.edges[k++ % g.edges.length];
    for (const p of e.pts) {
      const evs: SensorEvent[] = [
        { type: 'step', t: t + 0.3, heading: 90 }, { type: 'step', t: t + 0.8, heading: 90 },
        { type: 'baro', t: t + 0.9, h: p[2] - g.nodes[0].z },
        { type: 'fix', t: t + 1, x: p[0] + 10 * Math.sin(t * 1.3), y: p[1] + 10 * Math.cos(t * 0.7), acc: 15 },
      ];
      for (const ev of evs) {
        const s = now();
        m.push(ev);
        if (ev.type === 'fix') times.push(now() - s);
      }
      t += 1;
    }
  }
  times.sort((a, b) => a - b);
  const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  return { buildMs, fixes: times.length, medianMs: q(0.5), p90Ms: q(0.9), p99Ms: q(0.99), maxMs: times[times.length - 1] };
}
