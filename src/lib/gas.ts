// google.script.run の Promise 化。
// - `{ error }` の戻り値は reject せずそのまま返す（呼び出し側で isGasError で判定する）。
// - 通信失敗・権限切れ（withFailureHandler）は Error で reject する。
// - 同時実行数を抑えるセマフォつき。応答が返らない呼び出しが枠を占有し続けないよう、
//   LEASE_MS を過ぎたら枠だけ返す（呼び出し自体は取り消せないので、応答が来れば普通に届く）。
// google.script.run を直接つかむのは defaultGetRun の 1 か所だけ。テストでは createGas({ getRun }) で差し替える。

import type { GasError } from './driveTypes';

/** google.script.run の最小限の形（ビルダー式） */
export interface GasRunner {
  withSuccessHandler(cb: (value: unknown) => void): GasRunner;
  withFailureHandler(cb: (error: unknown) => void): GasRunner;
  [fn: string]: unknown;
}

export const DEFAULT_LIMIT = 6;
/** GAS の 1 回の実行上限（6 分）より少し長く */
export const LEASE_MS = 7 * 60 * 1000;

/** ここだけが window.google.script.run に触れる */
function defaultGetRun(): GasRunner | undefined {
  const g = (globalThis as { google?: { script?: { run?: GasRunner } } }).google;
  return g?.script?.run;
}

export function isGasAvailable(): boolean {
  try {
    return !!defaultGetRun();
  } catch {
    return false;
  }
}

/** サーバー関数が返した業務上の失敗かどうか */
export function isGasError(v: unknown): v is GasError {
  return typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string';
}

export type GasCall = <T>(fn: string, ...args: unknown[]) => Promise<T | GasError>;

export interface GasDeps {
  getRun?: () => GasRunner | undefined;
  limit?: number;
  leaseMs?: number;
}

interface Job {
  fn: string;
  args: unknown[];
  resolve: (v: never) => void;
  reject: (e: unknown) => void;
}

export function createGas(deps: GasDeps = {}) {
  const getRun = deps.getRun ?? defaultGetRun;
  const limit = Math.max(1, Math.floor(deps.limit ?? DEFAULT_LIMIT));
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  let active = 0;
  let maxActive = 0;
  const queue: Job[] = [];

  function start(job: Job) {
    let run: GasRunner | undefined;
    try {
      run = getRun();
    } catch {
      run = undefined;
    }
    if (!run) {
      job.reject(new Error('Google ドライブと通信できる環境ではありません。'));
      return;
    }
    active++;
    if (active > maxActive) maxActive = active;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      active--;
      pump();
    };
    const timer = setTimeout(release, leaseMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      // ハンドラを結んだ「ビルダー」自身のメソッドとして呼ぶ（this を保つ）
      const builder = run
        .withSuccessHandler((v) => {
          release();
          job.resolve(v as never);
        })
        .withFailureHandler((e) => {
          release();
          const msg = e instanceof Error ? e.message : ((e as { message?: string } | null)?.message ?? String(e));
          job.reject(e instanceof Error ? e : new Error(msg));
        });
      const fn = builder[job.fn];
      if (typeof fn !== 'function') throw new Error(`サーバー関数 ${job.fn} が見つかりません。`);
      (fn as (...a: unknown[]) => void).apply(builder, job.args);
    } catch (e) {
      release();
      job.reject(e);
    }
  }

  function pump() {
    while (active < limit && queue.length > 0) start(queue.shift()!);
  }

  const call: GasCall = <T>(fn: string, ...args: unknown[]) =>
    new Promise<T | GasError>((resolve, reject) => {
      const job: Job = { fn, args, resolve: resolve as (v: never) => void, reject };
      if (active < limit && queue.length === 0) start(job);
      else queue.push(job);
    });

  return {
    call,
    stats: () => ({ active, waiting: queue.length, maxActive }),
  };
}

const defaultGas = createGas();

/** 既定の gas 呼び出し。業務上の失敗（{ error }）は reject せずそのまま返る。 */
export const gasCall: GasCall = defaultGas.call;
