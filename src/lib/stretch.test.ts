import { describe, expect, it } from 'vitest';
import { createStretcher, stretchAll } from './stretch';

const SR = 44100;

function sine(freq: number, seconds: number, sr = SR, amp = 0.5): Float32Array {
  const n = Math.round(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return a;
}

/** 負から正へのゼロ交差の数 ÷ 秒数 ≒ 周波数 */
function frequencyByZeroCrossings(x: Float32Array, sr = SR, from = 0, to = x.length): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n / ((to - from) / sr);
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

describe('stretch (WSOLA)', () => {
  for (const rate of [2, 1.5, 0.5, 0.25, 4]) {
    it(`rate ${rate}: length is about N / rate and the frequency is kept`, () => {
      const x = sine(440, 4);
      const [y] = stretchAll([x], SR, rate);
      expect(Math.abs(y.length - Math.round(x.length / rate))).toBeLessThanOrEqual(1);
      // 端の立ち上がり・立ち下がりを除いた中ほどで周波数を測る
      const from = Math.round(y.length * 0.1);
      const to = Math.round(y.length * 0.9);
      const f = frequencyByZeroCrossings(y, SR, from, to);
      expect(f).toBeGreaterThan(440 * 0.97);
      expect(f).toBeLessThan(440 * 1.03);
      // 音量も保たれる（正弦波 amp 0.5 の RMS ≒ 0.354）
      expect(rms(y, from, to)).toBeGreaterThan(0.3);
      expect(rms(y, from, to)).toBeLessThan(0.4);
    });
  }

  it('rate 1 is nearly the identity', () => {
    // 周波数が時間で変わる信号（掃引）でも、rate 1 なら入力とほぼ同じになる
    const n = SR * 2;
    const x = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += (2 * Math.PI * (200 + (600 * i) / n)) / SR;
      x[i] = 0.4 * Math.sin(phase);
    }
    const [y] = stretchAll([x], SR, 1);
    expect(y.length).toBe(x.length);
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(y[i] - x[i]));
    expect(maxDiff).toBeLessThan(0.01);
  });

  it('keeps silence silent', () => {
    for (const rate of [0.5, 2]) {
      const [y] = stretchAll([new Float32Array(SR * 2)], SR, rate);
      expect(Math.abs(y.length - Math.round((SR * 2) / rate))).toBeLessThanOrEqual(1);
      expect(rms(y)).toBe(0);
    }
  });

  it('handles multiple channels (each keeps its own frequency)', () => {
    const l = sine(300, 3);
    const r = sine(900, 3);
    const out = stretchAll([l, r], SR, 1.5);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(out[1].length);
    expect(Math.abs(out[0].length - Math.round(l.length / 1.5))).toBeLessThanOrEqual(1);
    const from = Math.round(out[0].length * 0.1);
    const to = Math.round(out[0].length * 0.9);
    expect(frequencyByZeroCrossings(out[0], SR, from, to)).toBeGreaterThan(300 * 0.97);
    expect(frequencyByZeroCrossings(out[0], SR, from, to)).toBeLessThan(300 * 1.03);
    expect(frequencyByZeroCrossings(out[1], SR, from, to)).toBeGreaterThan(900 * 0.97);
    expect(frequencyByZeroCrossings(out[1], SR, from, to)).toBeLessThan(900 * 1.03);
  });

  it('gives the same result whether input arrives in one piece or in small chunks', () => {
    const x = sine(523, 2);
    const [whole] = stretchAll([x], SR, 1.25);
    const s = createStretcher({ channels: 1, sampleRate: SR, rate: 1.25 });
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 1000) parts.push(...s.push([x.subarray(i, i + 1000)]));
    parts.push(...s.flush());
    const total = parts.reduce((n, p) => n + p.length, 0);
    expect(total).toBe(whole.length);
    const joined = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    for (let i = 0; i < total; i++) expect(Math.abs(joined[i] - whole[i])).toBeLessThan(1e-5);
  });

  it('rejects an invalid rate', () => {
    expect(() => createStretcher({ channels: 1, sampleRate: SR, rate: 0 })).toThrow();
    expect(() => createStretcher({ channels: 1, sampleRate: SR, rate: NaN })).toThrow();
  });
});
