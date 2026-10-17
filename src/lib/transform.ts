/**
 * 速度と音程を変える処理をまとめる。再生（webplayer.ts）と書き出し（engine.ts）で同じものを使うので、
 * 聞いたとおりの音で書き出される。
 *
 * speed = 速さの倍率（長さが 1/speed になる）、pitchRatio = 音程の倍率（2 で 1 オクターブ上）。
 * タイムストレッチ（WSOLA、rate = speed / pitchRatio）で長さだけ変えてから、
 * リサンプル（ratio = pitchRatio）で長さと音程を一緒に変える。全体として長さは 1/speed、音程は pitchRatio 倍になる。
 * - pitchRatio = 1: タイムストレッチだけ（音程を保って速度を変える）
 * - pitchRatio = speed: リサンプルだけ（テープのように速度と一緒に音程も変わる）
 */

import { createResampler } from './resample';
import { createStretcher, type Stretcher } from './stretch';

export interface TransformOptions {
  channels: number;
  sampleRate: number;
  speed: number;
  pitchRatio: number;
}

/** 1 とみなす誤差 */
const EPS = 1e-9;

/** 何もしなくてよい（速度も音程も元のまま） */
export function isIdentity(speed: number, pitchRatio: number): boolean {
  return Math.abs(speed - 1) < EPS && Math.abs(pitchRatio - 1) < EPS;
}

export function createTransform(opts: TransformOptions): Stretcher {
  const { channels, sampleRate, speed, pitchRatio } = opts;
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error('speed は 0 より大きい有限の数にしてください。');
  if (!(pitchRatio > 0) || !Number.isFinite(pitchRatio)) {
    throw new Error('pitchRatio は 0 より大きい有限の数にしてください。');
  }
  const stretchRate = speed / pitchRatio;
  const stages: Stretcher[] = [];
  if (Math.abs(stretchRate - 1) >= EPS) stages.push(createStretcher({ channels, sampleRate, rate: stretchRate }));
  if (Math.abs(pitchRatio - 1) >= EPS) stages.push(createResampler({ channels, ratio: pitchRatio }));

  return {
    push(planes) {
      let x = planes;
      for (const s of stages) x = s.push(x);
      return x;
    },
    flush() {
      // 前段の残りを後段に流してから、後段も flush する
      let rest: Float32Array[] | null = null;
      for (const s of stages) {
        const head: Float32Array[] | null = rest ? s.push(rest) : null;
        const tail = s.flush();
        rest = head ? concat(head, tail) : tail;
      }
      return rest ?? Array.from({ length: channels }, () => new Float32Array(0));
    },
    reset() {
      for (const s of stages) s.reset();
    },
  };
}

function concat(a: Float32Array[], b: Float32Array[]): Float32Array[] {
  return a.map((p, c) => {
    const out = new Float32Array(p.length + b[c].length);
    out.set(p);
    out.set(b[c], p.length);
    return out;
  });
}

/** まとめて処理する（テスト・短い音声向け） */
export function transformAll(planes: Float32Array[], sampleRate: number, speed: number, pitchRatio: number): Float32Array[] {
  const t = createTransform({ channels: planes.length, sampleRate, speed, pitchRatio });
  return concat(t.push(planes), t.flush());
}
