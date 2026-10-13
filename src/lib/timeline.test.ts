import { describe, expect, it } from 'vitest';
import { normalizePoints } from './plan';
import {
  addPoint,
  clamp,
  clampMarkerMove,
  labelFits,
  removePointAt,
  replacePoint,
  roundSec,
  secToRatio,
  stepTime,
  xToSec,
} from './timeline';

describe('座標変換', () => {
  it('xToSec は左端を 0、右端を duration にし、範囲外は丸める', () => {
    expect(xToSec(100, 100, 800, 7200)).toBe(0);
    expect(xToSec(500, 100, 800, 7200)).toBe(3600);
    expect(xToSec(900, 100, 800, 7200)).toBe(7200);
    expect(xToSec(0, 100, 800, 7200)).toBe(0);
    expect(xToSec(2000, 100, 800, 7200)).toBe(7200);
  });
  it('幅や長さが不正なら 0', () => {
    expect(xToSec(50, 0, 0, 100)).toBe(0);
    expect(xToSec(50, 0, 100, 0)).toBe(0);
  });
  it('secToRatio / stepTime / clamp', () => {
    expect(secToRatio(30, 120)).toBe(0.25);
    expect(secToRatio(-5, 120)).toBe(0);
    expect(secToRatio(500, 120)).toBe(1);
    expect(secToRatio(5, 0)).toBe(0);
    expect(stepTime(10, -20, 100)).toBe(0);
    expect(stepTime(95, 10, 100)).toBe(100);
    expect(stepTime(50, 5, 100)).toBe(55);
    expect(clamp(NaN, 1, 2)).toBe(1);
  });
  it('roundSec は 0.01 秒単位', () => {
    expect(roundSec(1.23456)).toBe(1.23);
  });
});

describe('clampMarkerMove', () => {
  const pts = [10, 20, 30];
  it('隣の点から 0.5 秒以上離れた範囲に収める', () => {
    const lo = clampMarkerMove(pts, 1, 0, 60);
    const hi = clampMarkerMove(pts, 1, 99, 60);
    expect(lo).toBeGreaterThanOrEqual(10.5);
    expect(hi).toBeLessThanOrEqual(29.5);
    expect(clampMarkerMove(pts, 1, 15, 60)).toBe(15);
  });
  it('両端も 0.5 秒の余裕を残す', () => {
    expect(clampMarkerMove(pts, 0, -5, 60)).toBeGreaterThanOrEqual(0.5);
    expect(clampMarkerMove(pts, 2, 999, 60)).toBeLessThanOrEqual(59.5);
  });
  it('動かせる範囲が無ければ現在位置のまま', () => {
    expect(clampMarkerMove([0.6], 0, 0.9, 1.0)).toBe(0.6);
  });
  it('結果は normalizePoints で落とされない（ランダム検証）', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let n = 0; n < 500; n++) {
      const duration = 5 + rnd() * 500;
      const raw = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => roundSec(rnd() * duration));
      const points = normalizePoints(raw, duration);
      if (points.length === 0) continue;
      const i = Math.floor(rnd() * points.length);
      const moved = roundSec(clampMarkerMove(points, i, rnd() * duration * 1.2 - 5, duration));
      const next = points.slice();
      next[i] = moved;
      expect(normalizePoints(next, duration)).toEqual(next);
    }
  });
});

describe('addPoint / removePointAt / replacePoint', () => {
  it('追加すると昇順に並ぶ', () => {
    expect(addPoint([10, 30], 20.004, 60)).toEqual([10, 20, 30]);
  });
  it('近すぎる・端の点は null', () => {
    expect(addPoint([10], 10.2, 60)).toBeNull();
    expect(addPoint([10], 0.2, 60)).toBeNull();
    expect(addPoint([10], 59.8, 60)).toBeNull();
    expect(addPoint([10], 10, 60)).toBeNull();
    expect(addPoint([10, 11], 10.7, 60)).toBeNull();
  });
  it('削除', () => {
    expect(removePointAt([1, 2, 3], 1)).toEqual([1, 3]);
  });
  it('置き換えは順序が入れ替わってもよいが、衝突したら null', () => {
    expect(replacePoint([10, 20, 30], 0, 25, 60)).toEqual([20, 25, 30]);
    expect(replacePoint([10, 20, 30], 0, 20.2, 60)).toBeNull();
    expect(replacePoint([10, 20, 30], 0, 60, 60)).toBeNull();
    expect(replacePoint([10, 20, 30], 1, 21, 60)).toEqual([10, 21, 30]);
  });
});

describe('labelFits', () => {
  it('区間の幅が十分あるときだけ表示する', () => {
    expect(labelFits(0, 100, 1000, 900)).toBe(true); // 90px
    expect(labelFits(0, 10, 1000, 900)).toBe(false); // 9px
    expect(labelFits(0, 10, 0, 900)).toBe(false);
  });
});
