/** 音程（半音）の範囲。±1 オクターブ */
export const MIN_PITCH = -12;
export const MAX_PITCH = 12;
/** スライダーの刻み（半音） */
export const PITCH_STEP = 1;

/** 範囲に収め、整数（半音）に丸める。非有限は 0 */
export function clampPitch(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, Math.round(semitones / PITCH_STEP) * PITCH_STEP));
}

/** `+3` / `-2` / `0` のように符号付きで表示する（単位は付けない） */
export function formatPitch(semitones: number): string {
  if (semitones > 0) return `+${semitones}`;
  if (semitones < 0) return `−${-semitones}`;
  return '0';
}

/**
 * 実際に鳴らす音程の倍率。
 * keepPitch = true なら速度を変えても音程は変わらず、半音の指定だけが効く。
 * false ならテープのように速度に比例して音程も変わり、そこへ半音の指定が重なる。
 */
export function pitchRatioOf(semitones: number, speed: number, keepPitch: boolean): number {
  return 2 ** (semitones / 12) * (keepPitch ? 1 : speed);
}
