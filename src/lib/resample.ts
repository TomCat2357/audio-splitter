/**
 * ストリーミングのリサンプラー（窓付き sinc）。音程を変える（テープを速く／遅く回すのと同じ）ために使う。
 * Web Audio には依存しない。planar（チャンネルごとの Float32Array）を push して、出力を受け取る。
 *
 * ratio = 出力 1 サンプルあたりに進む入力のサンプル数。2 なら長さが約 1/2 で音程が 1 オクターブ上がる。
 * flush() まで呼び終えると、全体の長さが round(入力 / ratio) になる。
 * 出力 j は入力の位置 j × ratio を中心に左右対称のカーネルで補間するので、遅延はない（先頭がそろう）。
 * ratio > 1（間引き）のときは、折り返しノイズが出ないよう遮断周波数を 1/ratio に下げる。
 */

import type { Stretcher } from './stretch';

/** カーネルの片側のゼロ交差の数（大きいほど急峻なフィルタ・重い） */
const ZEROS = 12;
/** カーネル表の 1 ゼロ交差あたりの分解能 */
const OVERSAMPLE = 256;

let kernelTable: Float32Array | null = null;

/** sinc × Blackman 窓の表。u（ゼロ交差単位の距離、0〜ZEROS）を OVERSAMPLE 刻みで持つ */
function kernel(): Float32Array {
  if (kernelTable) return kernelTable;
  const n = ZEROS * OVERSAMPLE + 2;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / OVERSAMPLE;
    if (u >= ZEROS) {
      t[i] = 0;
      continue;
    }
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const x = 0.5 + u / (2 * ZEROS); // 窓の中心が 0.5
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
    t[i] = sinc * w;
  }
  kernelTable = t;
  return t;
}

export interface ResampleOptions {
  channels: number;
  /** 0 より大きい有限の数 */
  ratio: number;
}

export function createResampler(opts: ResampleOptions): Stretcher {
  const { channels, ratio } = opts;
  if (!(ratio > 0) || !Number.isFinite(ratio)) throw new Error('ratio は 0 より大きい有限の数にしてください。');
  if (!(channels >= 1)) throw new Error('channels が不正です。');

  const table = kernel();
  const cutoff = Math.min(1, 1 / ratio);
  const reach = Math.ceil(ZEROS / cutoff); // 中心から片側に参照する入力サンプル数
  const scale = cutoff * OVERSAMPLE; // 入力サンプルの距離 → 表の添字

  let buf: Float32Array[] = [];
  let base = 0; // buf[0] の絶対位置
  let received = 0;
  let j = 0; // 次に出す出力の番号

  const reset = () => {
    buf = Array.from({ length: channels }, () => new Float32Array(0));
    base = 0;
    received = 0;
    j = 0;
  };
  reset();

  /** 出力を limit 個まで作る。入力が足りない分は final なら 0 とみなす */
  const run = (final: boolean, limit: number): Float32Array[] => {
    const have = base + buf[0].length;
    let count = 0;
    // 出せる数を先に数える（非 final は右側の参照が届く分だけ）
    while (count < limit) {
      const t = (j + count) * ratio;
      if (!final && Math.floor(t) + reach >= have) break;
      count++;
    }
    const out = Array.from({ length: channels }, () => new Float32Array(count));
    for (let n = 0; n < count; n++) {
      const t = (j + n) * ratio;
      const center = Math.floor(t);
      const lo = Math.max(center - reach + 1, base);
      const hi = Math.min(center + reach, have - 1);
      for (let c = 0; c < channels; c++) {
        const src = buf[c];
        let acc = 0;
        for (let k = lo; k <= hi; k++) {
          const pos = Math.abs(t - k) * scale;
          const i = Math.floor(pos);
          if (i >= table.length - 1) continue;
          const f = pos - i;
          acc += src[k - base] * (table[i] + (table[i + 1] - table[i]) * f);
        }
        out[c][n] = acc * cutoff;
      }
    }
    j += count;
    // もう参照しない入力を捨てる
    const keepFrom = Math.max(base, Math.floor(j * ratio) - reach);
    const drop = keepFrom - base;
    if (drop > 0 && drop >= 4096) {
      for (let c = 0; c < channels; c++) buf[c] = buf[c].slice(drop);
      base = keepFrom;
    }
    return out;
  };

  return {
    push(planes) {
      const frames = planes.length > 0 ? planes[0].length : 0;
      if (frames > 0) {
        const oldLen = buf[0].length;
        for (let c = 0; c < channels; c++) {
          const next = new Float32Array(oldLen + frames);
          next.set(buf[c]);
          const p = planes[c] ?? planes[0];
          next.set(p.subarray(0, frames), oldLen);
          buf[c] = next;
        }
        received += frames;
      }
      // 最終的な長さ（round(入力 / ratio)）を超えて出さない
      return run(false, Math.max(0, Math.floor(received / ratio) - j));
    },
    flush() {
      return run(true, Math.max(0, Math.round(received / ratio) - j));
    },
    reset,
  };
}
