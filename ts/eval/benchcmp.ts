import { readFileSync } from 'node:fs';
import { createMatcher as v2 } from '../src/matcher';
import { createMatcher as v1 } from './v1/matcher';
import { g, loadRoutes, q } from './common';
const routes = loadRoutes().slice(0, Number(process.argv[2] ?? 40));
for (const [name, mk] of [['v1', v1], ['v2', v2]] as const) {
  const lat: number[] = [];
  for (const r of routes) {
    const m = (mk as any)(g, { platform: r.platform });
    for (const e of r.events) { const s = performance.now(); m.push(e); if (e.type === 'fix') lat.push(performance.now() - s); }
  }
  console.log(name, 'median', q(lat, .5).toFixed(2), 'p99', q(lat, .99).toFixed(2), 'max', Math.max(...lat).toFixed(1));
}
