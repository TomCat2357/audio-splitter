import { describe, expect, it } from 'vitest';
import {
  MIN_SEGMENT_SEC,
  buildPartName,
  estimateOutputBytesPerSec,
  estimatePointsForMaxSize,
  formatBytes,
  formatTime,
  normalizePoints,
  parseTime,
  pointsForCount,
  pointsForInterval,
  segmentsFromPoints,
} from './plan';
import type { AudioInfo } from './types';

describe('normalizePoints', () => {
  it('sorts ascending', () => {
    expect(normalizePoints([30, 10, 20], 60)).toEqual([10, 20, 30]);
  });
  it('drops <=0, >=duration, NaN, Infinity', () => {
    expect(normalizePoints([-5, 0, 10, 60, 70, NaN, Infinity, -Infinity], 60)).toEqual([10]);
  });
  it('drops points closer than MIN to start', () => {
    expect(normalizePoints([MIN_SEGMENT_SEC - 0.01, 10], 60)).toEqual([10]);
    expect(normalizePoints([MIN_SEGMENT_SEC, 10], 60)).toEqual([MIN_SEGMENT_SEC, 10]);
  });
  it('drops points closer than MIN to end', () => {
    expect(normalizePoints([10, 60 - MIN_SEGMENT_SEC + 0.01], 60)).toEqual([10]);
    expect(normalizePoints([10, 60 - MIN_SEGMENT_SEC], 60)).toEqual([10, 60 - MIN_SEGMENT_SEC]);
  });
  it('drops points closer than MIN to the previous kept point', () => {
    expect(normalizePoints([10, 10.2, 10.6], 60)).toEqual([10, 10.6]);
    expect(normalizePoints([10, 10, 10], 60)).toEqual([10]);
  });
  it('handles empty input and invalid duration', () => {
    expect(normalizePoints([], 60)).toEqual([]);
    expect(normalizePoints([10], 0)).toEqual([]);
    expect(normalizePoints([10], -1)).toEqual([]);
    expect(normalizePoints([10], NaN)).toEqual([]);
  });
  it('does not mutate the input', () => {
    const a = [30, 10];
    normalizePoints(a, 60);
    expect(a).toEqual([30, 10]);
  });
});

describe('segmentsFromPoints', () => {
  it('returns one segment when no points', () => {
    expect(segmentsFromPoints([], 60)).toEqual([{ start: 0, end: 60 }]);
  });
  it('splits at points', () => {
    expect(segmentsFromPoints([40, 20], 60)).toEqual([
      { start: 0, end: 20 },
      { start: 20, end: 40 },
      { start: 40, end: 60 },
    ]);
  });
  it('ignores invalid points', () => {
    expect(segmentsFromPoints([0, 60, NaN], 60)).toEqual([{ start: 0, end: 60 }]);
  });
  it('returns [] for invalid duration', () => {
    expect(segmentsFromPoints([10], 0)).toEqual([]);
    expect(segmentsFromPoints([10], NaN)).toEqual([]);
  });
});

describe('pointsForInterval', () => {
  it('splits evenly', () => {
    expect(pointsForInterval(60, 20)).toEqual([20, 40]);
  });
  it('does not put a point at the exact end', () => {
    expect(pointsForInterval(40, 20)).toEqual([20]);
  });
  it('keeps a normal remainder as its own segment', () => {
    expect(pointsForInterval(65, 20)).toEqual([20, 40, 60]);
  });
  it('drops the last point when the remainder is shorter than MIN', () => {
    expect(pointsForInterval(60.3, 20)).toEqual([20, 40]);
    expect(pointsForInterval(60.5, 20)).toEqual([20, 40, 60]);
  });
  it('returns [] when interval >= duration', () => {
    expect(pointsForInterval(10, 10)).toEqual([]);
    expect(pointsForInterval(10, 100)).toEqual([]);
  });
  it('returns [] for invalid input', () => {
    expect(pointsForInterval(60, 0)).toEqual([]);
    expect(pointsForInterval(60, -5)).toEqual([]);
    expect(pointsForInterval(60, NaN)).toEqual([]);
    expect(pointsForInterval(0, 10)).toEqual([]);
    expect(pointsForInterval(NaN, 10)).toEqual([]);
    expect(pointsForInterval(1e9, 0.001)).toEqual([]); // 区間数が多すぎる
  });
});

describe('pointsForCount', () => {
  it('count=1 gives no points', () => {
    expect(pointsForCount(60, 1)).toEqual([]);
  });
  it('splits into equal parts', () => {
    expect(pointsForCount(60, 3)).toEqual([20, 40]);
    expect(pointsForCount(60, 2)).toEqual([30]);
  });
  it('floors non-integers', () => {
    expect(pointsForCount(60, 3.9)).toEqual([20, 40]);
  });
  it('returns [] for count < 1 or invalid', () => {
    expect(pointsForCount(60, 0)).toEqual([]);
    expect(pointsForCount(60, -2)).toEqual([]);
    expect(pointsForCount(60, 0.5)).toEqual([]);
    expect(pointsForCount(60, NaN)).toEqual([]);
    expect(pointsForCount(0, 3)).toEqual([]);
  });
  it('drops points that would create segments shorter than MIN', () => {
    expect(pointsForCount(1, 10)).toEqual([0.5]);
  });
});

describe('estimatePointsForMaxSize', () => {
  it('uses a 0.95 safety factor', () => {
    // 1000 bytes/s, max 10000 bytes -> 9.5 sec per part
    const pts = estimatePointsForMaxSize(30, 1000, 10000);
    expect(pts).toHaveLength(3);
    expect(pts[0]).toBeCloseTo(9.5);
    expect(pts[1]).toBeCloseTo(19);
    expect(pts[2]).toBeCloseTo(28.5);
  });
  it('returns [] when everything fits in one part', () => {
    expect(estimatePointsForMaxSize(5, 1000, 10000)).toEqual([]);
  });
  it('returns [] for invalid input', () => {
    expect(estimatePointsForMaxSize(30, 0, 10000)).toEqual([]);
    expect(estimatePointsForMaxSize(30, -1, 10000)).toEqual([]);
    expect(estimatePointsForMaxSize(30, 1000, 0)).toEqual([]);
    expect(estimatePointsForMaxSize(30, NaN, 10000)).toEqual([]);
    expect(estimatePointsForMaxSize(0, 1000, 10000)).toEqual([]);
  });
});

describe('formatTime', () => {
  it('formats m:ss', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9)).toBe('0:09');
    expect(formatTime(123)).toBe('2:03');
    expect(formatTime(599.99)).toBe('9:59');
  });
  it('formats h:mm:ss', () => {
    expect(formatTime(3600)).toBe('1:00:00');
    expect(formatTime(3723)).toBe('1:02:03');
  });
  it('formats fractions (truncated to 1 digit)', () => {
    expect(formatTime(123.45, { fraction: true })).toBe('2:03.4');
    expect(formatTime(59.99, { fraction: true })).toBe('0:59.9');
    expect(formatTime(3723.5, { fraction: true })).toBe('1:02:03.5');
    expect(formatTime(5, { fraction: true })).toBe('0:05.0');
  });
  it('treats negative / NaN as 0', () => {
    expect(formatTime(-5)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
  });
});

describe('parseTime', () => {
  it('parses seconds, m:ss, h:mm:ss', () => {
    expect(parseTime('90')).toBe(90);
    expect(parseTime('1:30')).toBe(90);
    expect(parseTime('1:02:03.5')).toBe(3723.5);
    expect(parseTime('0:00')).toBe(0);
    expect(parseTime('12.5')).toBe(12.5);
    expect(parseTime('  1:30  ')).toBe(90);
  });
  it('rejects invalid text', () => {
    for (const bad of ['', ' ', 'abc', '1:', ':30', '1:2:3:4', '-5', '1:60', '1:2.5:3', '1..5', '1,5', '1:30.', '.5']) {
      expect(parseTime(bad), bad).toBeNull();
    }
  });
  it('round-trips with formatTime', () => {
    expect(parseTime(formatTime(3723))).toBe(3723);
  });
});

describe('formatBytes', () => {
  it('formats units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(25 * 1024 * 1024)).toBe('25.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
  it('treats invalid as 0 B', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});

describe('buildPartName', () => {
  it('numbers with 2 digits', () => {
    expect(buildPartName('会議録音.m4a', 0, 3, 'm4a')).toBe('会議録音_01.m4a');
    expect(buildPartName('会議録音.m4a', 2, 3, 'm4a')).toBe('会議録音_03.m4a');
  });
  it('widens digits for 100+ parts', () => {
    expect(buildPartName('a.wav', 0, 100, 'wav')).toBe('a_001.wav');
    expect(buildPartName('a.wav', 99, 100, 'wav')).toBe('a_100.wav');
    expect(buildPartName('a.wav', 0, 99, 'wav')).toBe('a_01.wav');
  });
  it('uses _compressed for a single part so the original is not overwritten', () => {
    expect(buildPartName('会議録音.m4a', 0, 1, 'mp3')).toBe('会議録音_compressed.mp3');
    expect(buildPartName('会議録音.m4a', 0, 1, 'm4a')).toBe('会議録音_compressed.m4a');
  });
  it('accepts ext with a leading dot', () => {
    expect(buildPartName('a.m4a', 0, 2, '.mp3')).toBe('a_01.mp3');
  });
  it('only strips the last extension; handles no extension and dotfiles', () => {
    expect(buildPartName('a.b.c.m4a', 0, 2, 'm4a')).toBe('a.b.c_01.m4a');
    expect(buildPartName('noext', 0, 2, 'mp3')).toBe('noext_01.mp3');
    expect(buildPartName('.hidden', 0, 2, 'mp3')).toBe('.hidden_01.mp3');
  });
});

describe('estimateOutputBytesPerSec', () => {
  const info = { audioBitrate: 128000 } as AudioInfo;
  it('copy uses the source bitrate', () => {
    expect(estimateOutputBytesPerSec(info, { kind: 'copy' })).toBe(16000);
  });
  it('encode uses the target bitrate plus a small container margin', () => {
    const v = estimateOutputBytesPerSec(info, { kind: 'encode', format: 'mp3', bitrate: 64000, mono: false });
    expect(v).toBeGreaterThan(8000);
    expect(v).toBeLessThan(8000 * 1.1);
  });
});
