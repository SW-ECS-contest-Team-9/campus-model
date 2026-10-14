// GPS 믿음 모델 입력 특징. src/campus_model/features.py 와 같은 계산(동치 시험 있음).
import { inAnyFootprint } from './graph';

export const STRIDE_M = 0.7;

export class FeatureState {
  private fixes: [number, number, number][] = [];
  private steps: number[] = [];
  private baro: [number, number][] = [];
  private stepsSinceFix = 0;
  constructor(private fp: { footprints: [number, number][][] }, private platform: 'ios' | 'android' = 'ios') {}

  step(t: number): void {
    this.steps.push(t);
    this.stepsSinceFix++;
    while (this.steps.length && this.steps[0] < t - 10) this.steps.shift();
  }

  baroSample(t: number, h: number): void {
    this.baro.push([t, h]);
    while (this.baro.length > 1 && this.baro[1][0] <= t - 10) this.baro.shift();
  }

  fix(t: number, x: number, y: number, acc: number, speed: number, course: number): number[] {
    let dt = 60, jump = 0;
    if (this.fixes.length) {
      const [pt, px, py] = this.fixes[this.fixes.length - 1];
      dt = Math.min(t - pt, 60);
      jump = Math.hypot(x - px, y - py);
    }
    const resid = Math.max(0, jump - this.stepsSinceFix * STRIDE_M);
    this.fixes.push([t, x, y]);
    if (this.fixes.length > 5) this.fixes.shift();
    const m = this.fixes.length;
    const mx = this.fixes.reduce((a, f) => a + f[1], 0) / m;
    const my = this.fixes.reduce((a, f) => a + f[2], 0) / m;
    const spread = Math.sqrt(this.fixes.reduce((a, f) => a + (f[1] - mx) ** 2 + (f[2] - my) ** 2, 0) / m);
    let steps10 = 0;
    for (const s of this.steps) if (s > t - 10) steps10++;
    const bchg = this.baro.length ? Math.abs(this.baro[this.baro.length - 1][1] - this.baro[0][1]) : 0;
    this.stepsSinceFix = 0;
    return [
      Math.log(Math.max(acc, 1)),
      speed >= 0 ? 1 : 0,
      course >= 0 ? 1 : 0,
      Math.log1p(dt),
      Math.log1p(resid),
      Math.log1p(spread),
      inAnyFootprint(this.fp, x, y) ? 1 : 0,
      Math.min(bchg, 20),
      Math.min(steps10, 30),
      jump < 0.01 && m > 1 ? 1 : 0,
      this.platform === 'android' ? 1 : 0,
    ];
  }
}
