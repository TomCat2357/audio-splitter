import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VALUES,
  MB,
  buildPlan,
  displayPointsFor,
  parseNumber,
  runLabel,
  segmentRows,
  validateSettings,
} from './split';
import { createStore } from './store';

const vals = DEFAULT_VALUES;

describe('parseNumber', () => {
  it('数値のみ受け付ける', () => {
    expect(parseNumber(' 2.5 ')).toBe(2.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
  });
});

describe('validateSettings', () => {
  it('時間ごと', () => {
    expect(validateSettings('interval', vals, 3600, 8000)).toBeNull();
    expect(validateSettings('interval', { ...vals, intervalMin: '0' }, 3600, 8000)).not.toBeNull();
    expect(validateSettings('interval', { ...vals, intervalMin: '' }, 3600, 8000)).not.toBeNull();
    expect(validateSettings('interval', { ...vals, intervalMin: '0.01' }, 3600, 8000)).not.toBeNull();
  });
  it('等分とサイズ上限', () => {
    expect(validateSettings('count', { ...vals, count: '0' }, 600, 8000)).not.toBeNull();
    expect(validateSettings('count', { ...vals, count: '3' }, 600, 8000)).toBeNull();
    expect(validateSettings('maxSize', { ...vals, maxMB: '-1' }, 600, 8000)).not.toBeNull();
    expect(validateSettings('maxSize', { ...vals, maxMB: '0.0001' }, 36000, 8000)).not.toBeNull();
  });
  it('手動・分割しないは常に問題なし', () => {
    expect(validateSettings('manual', vals, 600, 8000)).toBeNull();
    expect(validateSettings('none', vals, 600, 8000)).toBeNull();
  });
});

describe('displayPointsFor / buildPlan', () => {
  it('モードごとの分割点', () => {
    expect(displayPointsFor('interval', [], vals, 1500, 8000)).toEqual([600, 1200]);
    expect(displayPointsFor('count', [], { ...vals, count: '3' }, 90, 8000)).toEqual([30, 60]);
    expect(displayPointsFor('none', [5], vals, 90, 8000)).toEqual([]);
    expect(displayPointsFor('manual', [5, 5.1, 20], vals, 90, 8000)).toEqual([5, 20]);
    expect(displayPointsFor('interval', [], { ...vals, intervalMin: 'x' }, 90, 8000)).toEqual([]);
  });
  it('サイズ上限は目安の点を出し、計画は maxSize', () => {
    const pts = displayPointsFor('maxSize', [], { ...vals, maxMB: '1' }, 600, 8000);
    expect(pts.length).toBeGreaterThan(0);
    expect(buildPlan('maxSize', { ...vals, maxMB: '1' }, pts)).toEqual({ kind: 'maxSize', maxBytes: MB });
    expect(buildPlan('none', vals, [3])).toEqual({ kind: 'points', points: [] });
    expect(buildPlan('manual', vals, [3])).toEqual({ kind: 'points', points: [3] });
  });
});

describe('segmentRows / runLabel', () => {
  it('区間とサイズ目安', () => {
    const rows = segmentRows([10], 30, 100);
    expect(rows).toEqual([
      { index: 0, start: 0, end: 10, bytes: 1000 },
      { index: 1, start: 10, end: 30, bytes: 2000 },
    ]);
  });
  it('ボタンの文言', () => {
    expect(runLabel('interval', 8, false)).toBe('8 個に分割して書き出す');
    expect(runLabel('none', 1, true)).toBe('圧縮して書き出す');
    expect(runLabel('none', 1, false)).toBe('そのまま書き出す');
    expect(runLabel('manual', 3, true)).toContain('3 個');
    // WAV / FLAC への変換は「圧縮」と言わない
    expect(runLabel('none', 1, true, true)).toBe('変換して書き出す');
    expect(runLabel('interval', 4, true, true)).toBe('4 個に分割・変換して書き出す');
    expect(runLabel('maxSize', 4, true, true)).toBe('サイズ上限で分割・変換して書き出す');
    expect(runLabel('maxSize', 4, true)).toBe('サイズ上限で分割・圧縮して書き出す');
    expect(runLabel('none', 1, false, true)).toBe('そのまま書き出す');
  });
});

describe('createStore', () => {
  it('値が変わったときだけ通知する', () => {
    const s = createStore(0);
    let n = 0;
    const off = s.subscribe(() => n++);
    s.set(0);
    s.set(1);
    expect(n).toBe(1);
    off();
    s.set(2);
    expect(n).toBe(1);
    expect(s.get()).toBe(2);
  });
});
