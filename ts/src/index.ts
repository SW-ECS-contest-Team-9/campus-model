import { createMatcher, type MatcherOptions } from './matcher';
import { loadTrustModel, type TrustModelJson } from './trust';
import type { Graph, MapPackage } from './graph';

export { createMatcher, type MatchResult, type MatcherOptions, type SensorEvent } from './matcher';
export { loadTrustModel, type TrustModel, type TrustModelJson } from './trust';
export { buildGraph, type Graph, type MapPackage } from './graph';
export { benchmarkMatcher } from './bench';

/** 건물 키 → GPS sigma 배수(createDefaultMatcher 기본). */
export const DEFAULT_GPS_DISTRUST: Record<string, number> = { 'b:북악관': 1.5 };

/**
 * 앱에서 부르는 한 줄. 2차 기본값: 안드로이드는 믿음 모델(trust_mlp_v2.json)을 쓰고,
 * iOS 는 쓰지 않는다(합성 평가에서 iOS 는 믿음 모델이 길 위 지표를 나쁘게 함).
 * GPS 높이(fix.alt, 정표고)는 안드로이드만 절대 높이로 쓴다(10-14 실측: 안드로이드 실내 수직 오차 약 1 m, iPhone 20~35 m).
 * 북악관은 벽이 두꺼워 GPS 가 유난히 틀린다(사용자 2026-10-22): 외곽선 안·15 m 안에서 GPS sigma 를 1.5배로(10-14 훑기: 1.5 가 2·3 보다 안드로이드 6F·층 바뀜이 낫고 iOS 는 비슷).
 */
export function createDefaultMatcher(
  pkg: MapPackage | Graph, platform: 'ios' | 'android', trustJson: TrustModelJson | null, options: MatcherOptions = {},
) {
  const trust = platform === 'android' && trustJson ? loadTrustModel(trustJson) : null;
  return createMatcher(pkg, { platform, trust, gpsAltMaxVacc: platform === 'android' ? 3 : 0, gpsDistrust: DEFAULT_GPS_DISTRUST, ...options });
}
