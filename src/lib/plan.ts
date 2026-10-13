import type { AudioInfo, EncodeFormat, OutputSpec } from './types';

/** これより短い区間は作らない（秒） */
export const MIN_SEGMENT_SEC = 0.5;

/** maxSize 見積もりの安全率 */
export const SAFETY_FACTOR = 0.95;

/** エンコード時のコンテナオーバーヘッド見込み（2%） */
const CONTAINER_OVERHEAD = 1.02;

/**
 * 分割点を整える。昇順ソート → 0 以下・durationSec 以上・非有限値を除外 →
 * 先頭・末尾・直前の採用点から MIN_SEGMENT_SEC 未満の点を落とす。
 * durationSec が不正（非有限・0 以下）なら空配列。
 */
export function normalizePoints(points: number[], durationSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const sorted = points.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p <= 0 || p >= durationSec) continue;
    if (p - prev < MIN_SEGMENT_SEC) continue;
    if (durationSec - p < MIN_SEGMENT_SEC) continue;
    out.push(p);
    prev = p;
  }
  return out;
}

/** 分割点から区間列を作る。点が無ければ全体 1 区間。durationSec が不正なら空配列。 */
export function segmentsFromPoints(
  points: number[],
  durationSec: number,
): { start: number; end: number }[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  const pts = normalizePoints(points, durationSec);
  const bounds = [0, ...pts, durationSec];
  const segs: { start: number; end: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) segs.push({ start: bounds[i], end: bounds[i + 1] });
  return segs;
}

/**
 * intervalSec ごとの分割点。最後の端数が MIN_SEGMENT_SEC 未満になる場合はその点を作らない
 * （直前の区間に吸収される）。intervalSec が 0 以下・非有限、durationSec が不正なら空配列。
 */
export function pointsForInterval(durationSec: number, intervalSec: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return [];
  // 区間数が膨大になるのを避ける（誤入力対策）
  if (durationSec / intervalSec > 100000) return [];
  const pts: number[] = [];
  for (let k = 1; k * intervalSec < durationSec; k++) pts.push(k * intervalSec);
  return normalizePoints(pts, durationSec);
}

/**
 * count 等分する分割点。count=1 なら空配列。count が 1 未満・非有限なら空配列。
 * 小数は切り捨て。各区間が MIN_SEGMENT_SEC 未満になる場合は normalize で落ちる。
 */
export function pointsForCount(durationSec: number, count: number): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (!Number.isFinite(count)) return [];
  const n = Math.floor(count);
  if (n < 2) return [];
  const pts: number[] = [];
  for (let k = 1; k < n; k++) pts.push((durationSec * k) / n);
  return normalizePoints(pts, durationSec);
}

/**
 * maxSize 指定時の画面プレビュー用の概算分割点。
 * 1 パートの長さ = maxBytes * SAFETY_FACTOR / bytesPerSec。引数が不正なら空配列。
 */
export function estimatePointsForMaxSize(
  durationSec: number,
  bytesPerSec: number,
  maxBytes: number,
): number[] {
  if (!(bytesPerSec > 0) || !(maxBytes > 0) || !Number.isFinite(bytesPerSec) || !Number.isFinite(maxBytes))
    return [];
  const segLen = (maxBytes * SAFETY_FACTOR) / bytesPerSec;
  return pointsForInterval(durationSec, segLen);
}

/** `1:02:03` / `2:03`。fraction 指定で `2:03.4`（小数第 1 位、切り捨て）。負数・非有限は 0 扱い。 */
export function formatTime(sec: number, opts?: { fraction?: boolean }): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const tenths = Math.floor(s * 10 + 1e-9);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
  return opts?.fraction ? `${base}.${frac}` : base;
}

/** `90` / `1:30` / `1:02:03.5` を秒に。不正なら null。 */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const parts = t.split(':');
  if (parts.length > 3) return null;
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    // 小数は最後（秒）の要素だけ許す
    const re = isLast ? /^\d+(\.\d+)?$/ : /^\d+$/;
    if (!re.test(part)) return null;
    nums.push(Number(part));
  }
  // 先頭以外（分・秒）は 60 未満
  for (let i = 1; i < nums.length; i++) if (nums[i] >= 60) return null;
  let total = 0;
  for (const n of nums) total = total * 60 + n;
  return Number.isFinite(total) ? total : null;
}

/** `12.3 MB` など（1024 進）。 */
export function formatBytes(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b < 1024) return `${Math.round(b)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * 出力ファイル名。`会議録音.m4a` → `会議録音_01.m4a`。桁数は max(2, total の桁数)。
 * total=1 のときは元ファイルを上書きしないよう `_<singleSuffix>`（既定 compressed）を付ける。
 * ext は `.mp3` でも `mp3` でもよい。
 */
export function buildPartName(
  originalName: string,
  index: number,
  total: number,
  ext: string,
  singleSuffix = 'compressed',
): string {
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  const e = ext.replace(/^\./, '');
  if (total <= 1) return `${stem}_${singleSuffix}.${e}`;
  const width = Math.max(2, String(total).length);
  return `${stem}_${String(index + 1).padStart(width, '0')}.${e}`;
}

/** FLAC の大きさの目安（WAV に対する割合）。内容によって変わるので初期値 */
export const FLAC_RATIO = 0.6;

/** ビットレートではなくサンプルレートとチャンネル数で大きさが決まる形式（WAV / FLAC） */
export function isPcmFormat(format: EncodeFormat): boolean {
  return format === 'wav' || format === 'flac';
}

/** 出力 1 秒あたりのバイト数の見積もり。 */
export function estimateOutputBytesPerSec(info: AudioInfo, output: OutputSpec): number {
  if (output.kind === 'copy') return info.audioBitrate / 8;
  if (isPcmFormat(output.format)) {
    const rate = output.sampleRate ?? info.sampleRate;
    const channels = output.mono ? 1 : info.numberOfChannels;
    const wav = rate * channels * 2 * CONTAINER_OVERHEAD; // 16bit
    return output.format === 'flac' ? wav * FLAC_RATIO : wav;
  }
  return (output.bitrate / 8) * CONTAINER_OVERHEAD;
}

/** 分割なし（1 個だけ書き出す）ときのファイル名の接尾辞。WAV / FLAC は「圧縮」ではなく「変換」 */
export function singleSuffixFor(output: OutputSpec): string {
  return output.kind === 'encode' && isPcmFormat(output.format) ? 'converted' : 'compressed';
}
