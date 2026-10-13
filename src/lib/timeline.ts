import { MIN_SEGMENT_SEC, normalizePoints } from './plan';

/** タイムラインの座標計算・分割点の編集に使う純粋関数 */

export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** 分割点は 0.01 秒単位に丸める */
export function roundSec(sec: number): number {
  return Math.round(sec * 100) / 100;
}

/** 秒 → 0〜1 の割合 */
export function secToRatio(sec: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return clamp(sec / duration, 0, 1);
}

/** 画面の x 座標 → 秒。バーの左端 left・幅 width（px）から計算する。範囲外は端に丸める。 */
export function xToSec(clientX: number, left: number, width: number, duration: number): number {
  if (!(width > 0) || !(duration > 0)) return 0;
  return clamp((clientX - left) / width, 0, 1) * duration;
}

/** 現在位置を delta 秒動かす（0〜duration に収める） */
export function stepTime(current: number, delta: number, duration: number): number {
  return clamp(current + delta, 0, Math.max(0, duration));
}

/**
 * index 番目のマーカーを sec に動かしたいとき、隣の点（または両端）から
 * MIN_SEGMENT_SEC 以上離れた範囲に収めた位置を返す。動かせる範囲が無ければ現在位置のまま。
 * 浮動小数点の誤差で normalizePoints に落とされないよう、0.01 秒の余裕を持たせる。
 */
export function clampMarkerMove(
  points: number[],
  index: number,
  sec: number,
  duration: number,
): number {
  const cur = points[index];
  const prev = index > 0 ? points[index - 1] : 0;
  const next = index < points.length - 1 ? points[index + 1] : duration;
  const lo = Math.ceil((prev + MIN_SEGMENT_SEC) * 100) / 100 + 0.01;
  const hi = Math.floor((next - MIN_SEGMENT_SEC) * 100) / 100 - 0.01;
  if (lo > hi) return cur;
  return clamp(sec, lo, hi);
}

/** 分割点を 1 つ追加した配列。端や他の点に近すぎて追加できなければ null。 */
export function addPoint(points: number[], sec: number, duration: number): number[] | null {
  const p = roundSec(sec);
  const before = normalizePoints(points, duration);
  const after = normalizePoints([...before, p], duration);
  if (after.length !== before.length + 1 || !after.includes(p)) return null;
  return after;
}

export function removePointAt(points: number[], index: number): number[] {
  return points.filter((_, i) => i !== index);
}

/** index 番目の点を sec に置き換えた配列（並べ替えあり）。条件に合わなければ null。 */
export function replacePoint(
  points: number[],
  index: number,
  sec: number,
  duration: number,
): number[] | null {
  const p = roundSec(sec);
  const others = points.filter((_, i) => i !== index);
  const after = normalizePoints([...others, p], duration);
  if (after.length !== points.length || !after.includes(p)) return null;
  return after;
}

/** 区間番号をバーの中に表示できる幅があるか */
export function labelFits(
  start: number,
  end: number,
  duration: number,
  trackWidthPx: number,
  minPx = 28,
): boolean {
  if (!(duration > 0) || !(trackWidthPx > 0)) return false;
  return ((end - start) / duration) * trackWidthPx >= minPx;
}
