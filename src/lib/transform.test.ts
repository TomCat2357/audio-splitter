import { describe, expect, it } from 'vitest';
import { clampPitch, formatPitch, pitchRatioOf } from './pitch';
import { createResampler } from './resample';
import { createTransform, isIdentity, transformAll } from './transform';

const SR = 44100;

function sine(freq: number, seconds: number, sr = SR, amp = 0.5): Float32Array {
  const n = Math.round(seconds * sr);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return a;
}

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

/** 中ほど（端の 10% を除く）の周波数と音量 */
function measure(y: Float32Array) {
  const from = Math.round(y.length * 0.1);
  const to = Math.round(y.length * 0.9);
  return { f: frequencyByZeroCrossings(y, SR, from, to), level: rms(y, from, to) };
}

describe('transform (speed × pitch)', () => {
  const cases = [
    // 音程を変えずに速度だけ
    { name: 'speed 2, keep pitch', speed: 2, ratio: 1 },
    // 速度を変えずに音程だけ
    { name: 'pitch +12', speed: 1, ratio: 2 },
    { name: 'pitch -12', speed: 1, ratio: 0.5 },
    { name: 'pitch +5', speed: 1, ratio: 2 ** (5 / 12) },
    // テープのように速度と一緒に音程も
    { name: 'tape ×2', speed: 2, ratio: 2 },
    { name: 'tape ×0.5', speed: 0.5, ratio: 0.5 },
    // 両方
    { name: 'speed 1.5, pitch -3', speed: 1.5, ratio: 2 ** (-3 / 12) },
    { name: 'speed 4, tape, pitch +12', speed: 4, ratio: 8 },
  ];
  for (const c of cases) {
    it(`${c.name}: length is N / speed and frequency is × ratio`, () => {
      const x = sine(440, 3);
      const [y] = transformAll([x], SR, c.speed, c.ratio);
      expect(Math.abs(y.length - Math.round(x.length / c.speed))).toBeLessThanOrEqual(2);
      const { f, level } = measure(y);
      expect(f).toBeGreaterThan(440 * c.ratio * 0.97);
      expect(f).toBeLessThan(440 * c.ratio * 1.03);
      expect(level).toBeGreaterThan(0.3);
      expect(level).toBeLessThan(0.4);
    });
  }

  it('gives the same result whether pushed at once or in small pieces', () => {
    const x = sine(300, 2);
    const [whole] = transformAll([x], SR, 1.25, 2 ** (4 / 12));
    const t = createTransform({ channels: 1, sampleRate: SR, speed: 1.25, pitchRatio: 2 ** (4 / 12) });
    const parts: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 1000) parts.push(t.push([x.subarray(i, i + 1000)])[0]);
    parts.push(t.flush()[0]);
    const total = parts.reduce((s, p) => s + p.length, 0);
    expect(total).toBe(whole.length);
    const joined = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      joined.set(p, o);
      o += p.length;
    }
    let maxDiff = 0;
    for (let i = 0; i < total; i++) maxDiff = Math.max(maxDiff, Math.abs(joined[i] - whole[i]));
    expect(maxDiff).toBeLessThan(1e-4);
  });

  it('keeps stereo channels separate', () => {
    const l = sine(440, 1);
    const r = sine(660, 1);
    const [yl, yr] = transformAll([l, r], SR, 1, 2 ** (2 / 12));
    const k = 2 ** (2 / 12);
    expect(measure(yl).f).toBeCloseTo(440 * k, -1);
    expect(measure(yr).f).toBeCloseTo(660 * k, -1);
  });

  it('isIdentity', () => {
    expect(isIdentity(1, 1)).toBe(true);
    expect(isIdentity(1, 2)).toBe(false);
    expect(isIdentity(1.5, 1)).toBe(false);
  });
});

describe('resampler', () => {
  it('ratio 1 is the identity', () => {
    const x = sine(1000, 0.5);
    const r = createResampler({ channels: 1, ratio: 1 });
    const a = r.push([x])[0];
    const b = r.flush()[0];
    expect(a.length + b.length).toBe(x.length);
    const y = new Float32Array(x.length);
    y.set(a);
    y.set(b, a.length);
    let maxDiff = 0;
    for (let i = 0; i < x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(y[i] - x[i]));
    expect(maxDiff).toBeLessThan(1e-3);
  });

  it('suppresses aliasing when shifting up (lowpass at 1/ratio)', () => {
    // 15 kHz を 1 オクターブ上げると 30 kHz（ナイキスト超え）になるので、ほぼ消えるべき
    const x = sine(15000, 1);
    const [y] = transformAll([x], SR, 1, 2);
    expect(measure(y).level).toBeLessThan(0.02);
  });
});

describe('pitch helpers', () => {
  it('clampPitch rounds to semitones within ±12', () => {
    expect(clampPitch(3.4)).toBe(3);
    expect(clampPitch(-20)).toBe(-12);
    expect(clampPitch(99)).toBe(12);
    expect(clampPitch(Number.NaN)).toBe(0);
  });
  it('formatPitch shows the sign', () => {
    expect(formatPitch(3)).toBe('+3');
    expect(formatPitch(-2)).toBe('−2');
    expect(formatPitch(0)).toBe('0');
  });
  it('pitchRatioOf', () => {
    expect(pitchRatioOf(12, 1.5, true)).toBeCloseTo(2);
    expect(pitchRatioOf(0, 1.5, false)).toBeCloseTo(1.5);
    expect(pitchRatioOf(-12, 2, false)).toBeCloseTo(1);
  });
});
