// Node 에서 기기용 벤치마크 함수를 그대로 돌린다(기기 값의 대리 지표).
import { readFileSync } from 'node:fs';
import { benchmarkMatcher } from '../src/bench';
import { loadTrustModel } from '../src/trust';
const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('data/package.json', root), 'utf8'));
const trust = loadTrustModel(JSON.parse(readFileSync(new URL('models/trust_mlp.json', root), 'utf8')));
console.log('HMM', benchmarkMatcher(pkg, {}, 2000));
console.log('HMM+trust', benchmarkMatcher(pkg, { trust }, 2000));
const mem = process.memoryUsage();
console.log('heapUsed MB', (mem.heapUsed / 1e6).toFixed(1));
