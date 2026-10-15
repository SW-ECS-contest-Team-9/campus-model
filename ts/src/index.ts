import { createMatcher, type MatcherOptions } from './matcher';
import { loadTrustModel, type TrustModelJson } from './trust';
import type { Graph, MapPackage } from './graph';

export { createMatcher, type MatchResult, type MatcherOptions, type SensorEvent } from './matcher';
export { loadTrustModel, type TrustModel, type TrustModelJson } from './trust';
export { buildGraph, type Graph, type MapPackage } from './graph';
export { benchmarkMatcher } from './bench';

/**
 * 앱에서 부르는 한 줄. 2차 기본값: 안드로이드는 믿음 모델(trust_mlp_v2.json)을 쓰고,
 * iOS 는 쓰지 않는다(합성 평가에서 iOS 는 믿음 모델이 길 위 지표를 나쁘게 함).
 */
export function createDefaultMatcher(
  pkg: MapPackage | Graph, platform: 'ios' | 'android', trustJson: TrustModelJson | null, options: MatcherOptions = {},
) {
  const trust = platform === 'android' && trustJson ? loadTrustModel(trustJson) : null;
  return createMatcher(pkg, { platform, trust, ...options });
}
