/**
 * ピッチを保ったまま速度だけ変えるタイムストレッチ（WSOLA）。音声・録音向け。
 * Web Audio には依存しない。planar（チャンネルごとの Float32Array）を push して、出力を受け取る。
 *
 * rate = 再生速度の倍率。2 なら長さが約 1/2、0.5 なら約 2 倍になる。
 * 出力は入力 1 サンプルあたり 1/rate サンプル。flush() まで呼び終えると、全体の長さが round(入力 / rate) になる。
 *
 * 仕組み: 一定間隔（half）で出力側に窓（Hann）を重ねていく。入力側は half × rate ずつ進め、
 * 各窓の取り出し位置は「直前の窓の続き」に波形が最もよく似る位置を ±tol の範囲で探して決める。
 */

export interface StretchOptions {
  channels: number;
  sampleRate: number;
  /** 0 より大きい有限の倍率 */
  rate: number;
}

export interface Stretcher {
  /** 入力を渡し、できあがった分の出力を返す（0 フレームのこともある） */
  push(planes: Float32Array[]): Float32Array[];
  /** 入力の終わり。残りをすべて返す。以後は reset() するまで使えない */
  flush(): Float32Array[];
  /** 最初の状態に戻す（別の区間を続けて処理するとき） */
  reset(): void;
}

/** 窓の半分の長さ（秒）。窓全体は 30 ms */
const HALF_SEC = 0.015;
/** 取り出し位置を探す範囲（秒、±） */
const TOLERANCE_SEC = 0.01;
/** 位置探索に使う間引き後のサンプルレートの目安（Hz） */
const SEARCH_RATE = 10000;

export function createStretcher(opts: StretchOptions): Stretcher {
  const { channels, sampleRate, rate } = opts;
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('rate は 0 より大きい有限の数にしてください。');
  if (!(channels >= 1) || !(sampleRate > 0)) throw new Error('channels / sampleRate が不正です。');

  const half = Math.max(16, Math.round(sampleRate * HALF_SEC));
  const win = half * 2;
  const tol = Math.max(4, Math.round(sampleRate * TOLERANCE_SEC));
  const ha = half * rate; // 入力側の送り幅（小数）
  const stride = Math.max(1, Math.floor(sampleRate / SEARCH_RATE));
  const nRef = Math.floor(win / stride);
  const hann = new Float32Array(win);
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win);

  // ---- 状態 ----
  let buf: Float32Array[] = [];
  let mono = new Float32Array(0);
  let base = 0; // buf[0] の絶対位置（入力先頭からのサンプル数）
  let received = 0; // 実際に受け取った入力サンプル数
  let k = 0; // 次に置く窓の番号
  let prevPos = 0; // 直前の窓の取り出し位置（絶対）
  let emitted = 0; // 返した出力サンプル数
  let acc: Float32Array[] = [];
  const ref = new Float32Array(nRef);

  const reset = () => {
    buf = Array.from({ length: channels }, () => new Float32Array(0));
    mono = new Float32Array(0);
    base = 0;
    received = 0;
    k = 0;
    prevPos = 0;
    emitted = 0;
    acc = Array.from({ length: channels }, () => new Float32Array(win));
  };
  reset();

  const append = (planes: Float32Array[], frames: number) => {
    const oldLen = buf[0].length;
    const newMono = new Float32Array(oldLen + frames);
    newMono.set(mono);
    for (let c = 0; c < channels; c++) {
      const next = new Float32Array(oldLen + frames);
      next.set(buf[c]);
      if (planes[c]) next.set(planes[c].subarray(0, frames), oldLen);
      buf[c] = next;
      for (let i = 0; i < frames; i++) newMono[oldLen + i] += next[oldLen + i];
    }
    if (channels > 1) for (let i = 0; i < frames; i++) newMono[oldLen + i] /= channels;
    mono = newMono;
  };

  /** 位置 p の窓と ref の相関（正規化）。大きいほど似ている */
  const score = (p: number): number => {
    const o = p - base;
    let dot = 0;
    let e = 0;
    for (let j = 0; j < nRef; j++) {
      const x = mono[o + j * stride];
      dot += x * ref[j];
      e += x * x;
    }
    return dot / Math.sqrt(e + 1e-10 * nRef);
  };

  /** target を中心に ±tol で、refPos の続きに最も似る位置を返す */
  const findPos = (refPos: number, target: number): number => {
    const lo = Math.max(0, target - tol);
    const hi = target + tol;
    const ro = refPos - base;
    for (let j = 0; j < nRef; j++) ref[j] = mono[ro + j * stride];
    let best = Math.min(Math.max(target, lo), hi);
    let bestScore = score(best);
    const better = (s: number) => s > bestScore + 1e-9 * Math.abs(bestScore) + 1e-12;
    // 粗い探索（stride 刻み、中心に近い順）
    const center = best;
    for (let m = 1; m * stride <= tol; m++) {
      for (const sign of [1, -1]) {
        const p = center + sign * m * stride;
        if (p < lo || p > hi) continue;
        const s = score(p);
        if (better(s)) {
          bestScore = s;
          best = p;
        }
      }
    }
    // 細かい探索（粗い結果の前後 stride - 1）
    const coarse = best;
    for (let d = 1; d < stride; d++) {
      for (const sign of [1, -1]) {
        const p = coarse + sign * d;
        if (p < lo || p > hi) continue;
        const s = score(p);
        if (better(s)) {
          bestScore = s;
          best = p;
        }
      }
    }
    return best;
  };

  /** 窓を 1 つ置き、確定した half サンプルを out に追記する。入力が足りなければ false（final なら 0 で埋める） */
  const step = (final: boolean, out: Float32Array[][]): boolean => {
    const target = Math.round(k * ha);
    const refPos = prevPos + half;
    const need = k === 0 ? win : Math.max(target + tol + win, refPos + win);
    const have = base + buf[0].length;
    if (have < need) {
      if (!final) return false;
      const pad = need - have;
      append(Array.from({ length: channels }, () => new Float32Array(pad)), pad);
    }
    const pos = k === 0 ? 0 : findPos(refPos, target);
    const off = pos - base;
    const block: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const a = acc[c];
      const src = buf[c];
      if (k === 0) {
        for (let i = 0; i < half; i++) a[i] += src[off + i];
      } else {
        for (let i = 0; i < half; i++) a[i] += hann[i] * src[off + i];
      }
      for (let i = half; i < win; i++) a[i] += hann[i] * src[off + i];
      block.push(a.slice(0, half));
      a.copyWithin(0, half);
      a.fill(0, half);
    }
    out.push(block);
    prevPos = pos;
    k++;
    // もう参照しない入力を捨てる
    const keepFrom = Math.max(base, Math.min(prevPos + half, Math.round(k * ha) - tol));
    const drop = keepFrom - base;
    if (drop > 0 && drop >= win * 4) {
      for (let c = 0; c < channels; c++) buf[c] = buf[c].slice(drop);
      mono = mono.slice(drop);
      base = keepFrom;
    }
    return true;
  };

  const collect = (blocks: Float32Array[][], limit: number): Float32Array[] => {
    let total = 0;
    for (const b of blocks) total += b[0].length;
    total = Math.max(0, Math.min(total, limit));
    const out = Array.from({ length: channels }, () => new Float32Array(total));
    let o = 0;
    for (const b of blocks) {
      if (o >= total) break;
      const n = Math.min(b[0].length, total - o);
      for (let c = 0; c < channels; c++) out[c].set(n === b[0].length ? b[c] : b[c].subarray(0, n), o);
      o += n;
    }
    emitted += total;
    return out;
  };

  return {
    push(planes) {
      const frames = planes.length > 0 ? planes[0].length : 0;
      if (frames > 0) {
        append(planes, frames);
        received += frames;
      }
      const blocks: Float32Array[][] = [];
      // 最終的な長さ（round(入力 / rate)）を超えて出さないよう、確定分が入力の範囲内のときだけ進める
      let count = emitted;
      while (count + half <= Math.floor(received / rate) && step(false, blocks)) count += half;
      return collect(blocks, Infinity);
    },
    flush() {
      const totalOut = Math.round(received / rate);
      const blocks: Float32Array[][] = [];
      let count = emitted;
      for (const b of blocks) count += b[0].length;
      while (count < totalOut) {
        step(true, blocks);
        count += half;
      }
      return collect(blocks, totalOut - emitted);
    },
    reset,
  };
}

/** まとめて処理する（テスト・短い音声向け） */
export function stretchAll(planes: Float32Array[], sampleRate: number, rate: number): Float32Array[] {
  const s = createStretcher({ channels: planes.length, sampleRate, rate });
  const a = s.push(planes);
  const b = s.flush();
  return a.map((p, c) => {
    const out = new Float32Array(p.length + b[c].length);
    out.set(p);
    out.set(b[c], p.length);
    return out;
  });
}
