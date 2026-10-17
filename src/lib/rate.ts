/** 再生速度の範囲（Firefox は 0.25〜4 の外でミュートするので、この範囲に留める） */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;
/** スライダーの刻み。クランプ時もこの刻みに丸める */
export const RATE_STEP = 0.05;
/** ショートカット（[ / ]）で増減する幅 */
export const RATE_KEY_STEP = 0.25;
/** よく使う速度のボタン */
export const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** 範囲に収め、0.05 刻みに丸める。非有限は 1 倍 */
export function clampRate(r: number): number {
  if (!Number.isFinite(r)) return 1;
  const stepped = Math.round(r / RATE_STEP) * RATE_STEP;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(stepped * 100) / 100));
}

/** `1.5` / `0.25` のように余分な 0 を付けずに表示する（× は付けない） */
export function formatRate(r: number): string {
  return String(Math.round(r * 100) / 100);
}
