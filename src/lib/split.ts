import {
  estimatePointsForMaxSize,
  normalizePoints,
  pointsForCount,
  pointsForInterval,
  SAFETY_FACTOR,
} from './plan';
import type { SplitPlan } from './types';

export type SplitMode = 'manual' | 'interval' | 'count' | 'maxSize' | 'none';

export interface SplitValues {
  intervalMin: string; // 分
  count: string; // 個
  maxMB: string; // MB (1024*1024 バイト)
}

export const DEFAULT_VALUES: SplitValues = { intervalMin: '10', count: '2', maxMB: '25' };

/** 画面で扱う分割数の上限（誤入力で画面が固まるのを防ぐ） */
export const MAX_PARTS = 1000;

export const MB = 1024 * 1024;

/** 数値入力欄の文字列を数値に。空・不正は null。 */
export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 入力値に問題があればその説明（平易な日本語）、なければ null。手動・分割しないは常に問題なし。 */
export function validateSettings(
  mode: SplitMode,
  vals: SplitValues,
  durationSec: number,
  bytesPerSec: number,
): string | null {
  if (mode === 'interval') {
    const n = parseNumber(vals.intervalMin);
    if (n === null || !(n > 0)) return '間隔（分）には 0 より大きい数を入力してください。';
    if (durationSec / (n * 60) > MAX_PARTS)
      return `分割数が多すぎます（上限 ${MAX_PARTS} 個）。間隔を長くしてください。`;
  } else if (mode === 'count') {
    const n = parseNumber(vals.count);
    if (n === null || n < 1) return '個数には 1 以上の数を入力してください。';
    if (Math.floor(n) > MAX_PARTS) return `個数が多すぎます（上限 ${MAX_PARTS} 個）。`;
  } else if (mode === 'maxSize') {
    const n = parseNumber(vals.maxMB);
    if (n === null || !(n > 0)) return 'サイズ上限（MB）には 0 より大きい数を入力してください。';
    if (bytesPerSec > 0) {
      const segLen = (n * MB * SAFETY_FACTOR) / bytesPerSec;
      if (durationSec / segLen > MAX_PARTS)
        return `サイズ上限が小さすぎます（分割数が ${MAX_PARTS} 個を超えます）。上限を大きくしてください。`;
    }
  }
  return null;
}

/** いま画面に出す分割点（手動の点、または自動モードのプレビュー）。常に normalizePoints 済み。 */
export function displayPointsFor(
  mode: SplitMode,
  manualPoints: number[],
  vals: SplitValues,
  durationSec: number,
  bytesPerSec: number,
): number[] {
  if (validateSettings(mode, vals, durationSec, bytesPerSec) !== null) return [];
  let pts: number[] = [];
  if (mode === 'manual') pts = manualPoints;
  else if (mode === 'interval') pts = pointsForInterval(durationSec, (parseNumber(vals.intervalMin) ?? 0) * 60);
  else if (mode === 'count') pts = pointsForCount(durationSec, parseNumber(vals.count) ?? 0);
  else if (mode === 'maxSize')
    pts = estimatePointsForMaxSize(durationSec, bytesPerSec, (parseNumber(vals.maxMB) ?? 0) * MB);
  return normalizePoints(pts, durationSec);
}

/** runJob に渡す分割計画 */
export function buildPlan(mode: SplitMode, vals: SplitValues, points: number[]): SplitPlan {
  if (mode === 'maxSize') return { kind: 'maxSize', maxBytes: (parseNumber(vals.maxMB) ?? 0) * MB };
  if (mode === 'none') return { kind: 'points', points: [] };
  return { kind: 'points', points };
}

export interface SegmentRow {
  index: number;
  start: number;
  end: number;
  bytes: number;
}

/** 区間ごとの開始・終了・サイズ目安 */
export function segmentRows(
  points: number[],
  durationSec: number,
  bytesPerSec: number,
): SegmentRow[] {
  if (!(durationSec > 0)) return [];
  const bounds = [0, ...points, durationSec];
  const rows: SegmentRow[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    rows.push({ index: i, start, end, bytes: Math.max(0, bytesPerSec) * (end - start) });
  }
  return rows;
}

/** 実行ボタンの文言。convert = WAV / FLAC への変換（「圧縮」ではないので言い方を変える） */
export function runLabel(mode: SplitMode, partCount: number, encode: boolean, convert = false): string {
  const verb = convert ? '変換' : '圧縮';
  if (mode === 'maxSize') return encode ? `サイズ上限で分割・${verb}して書き出す` : 'サイズ上限で分割して書き出す';
  if (partCount <= 1) return encode ? `${verb}して書き出す` : 'そのまま書き出す';
  return encode ? `${partCount} 個に分割・${verb}して書き出す` : `${partCount} 個に分割して書き出す`;
}
