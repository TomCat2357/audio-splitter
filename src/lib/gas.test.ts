import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGas, isGasAvailable, isGasError, normalizeArgs, type GasRunner } from './gas';

/** google.script.run の偽物。ビルダー式（this はハンドラを結んだビルダー自身でなければ失敗）で、呼び出しを記録し、応答は手動で返す */
function simpleRun() {
  const calls: { fn: string; args: unknown[]; ok: (v: unknown) => void; ng: (e: unknown) => void }[] = [];
  function builder(ok: (v: unknown) => void, ng: (e: unknown) => void): GasRunner {
    const b: GasRunner = {
      withSuccessHandler: (o) => builder(o, ng),
      withFailureHandler: (n) => builder(ok, n),
    };
    const handler = {
      get(t: GasRunner, k: string, receiver: unknown) {
        if (k in t) return t[k];
        return function (this: unknown, ...args: unknown[]) {
          if (this !== receiver) throw new Error('this がビルダーではありません');
          calls.push({ fn: k, args, ok, ng });
        };
      },
    };
    return new Proxy(b, handler);
  }
  return { run: builder(() => {}, () => {}), calls };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { google?: unknown }).google;
});

describe('gas: Promise 化', () => {
  it('成功の戻り値をそのまま返し、引数をサーバー関数へ渡す', async () => {
    const f = simpleRun();
    const gas = createGas({ getRun: () => f.run });
    const p = gas.call('listFolder', 'root', { foldersOnly: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].fn).toBe('listFolder');
    expect(f.calls[0].args).toEqual(['root', { foldersOnly: true }]);
    f.calls[0].ok({ folder: 1 });
    await expect(p).resolves.toEqual({ folder: 1 });
  });

  it('引数の正規化: 末尾の undefined は落とし、途中の undefined は null にする（サーバー関数に undefined を渡さない）', async () => {
    const f = simpleRun();
    const gas = createGas({ getRun: () => f.run });
    void gas.call('listFolder', 'root', undefined);
    void gas.call('a', undefined, 'x', undefined, undefined);
    void gas.call('b', undefined);
    void gas.call('c');
    void gas.call('d', 0, '', false, null, { o: 1 });
    expect(f.calls.map((c) => c.args)).toEqual([['root'], [null, 'x'], [], [], [0, '', false, null, { o: 1 }]]);
    expect(normalizeArgs([])).toEqual([]);
    expect(normalizeArgs([undefined, undefined])).toEqual([]);
    expect(normalizeArgs([1, undefined, 2])).toEqual([1, null, 2]);
  });

  it('{ error } の戻り値は reject せずそのまま返す', async () => {
    const f = simpleRun();
    const gas = createGas({ getRun: () => f.run });
    const p = gas.call('getFileInfo', 'x');
    f.calls[0].ok({ error: '見つかりません', code: 'NOT_FOUND' });
    const res = await p;
    expect(isGasError(res)).toBe(true);
    expect(res).toEqual({ error: '見つかりません', code: 'NOT_FOUND' });
  });

  it('通信失敗（failure handler）は Error で reject する', async () => {
    const f = simpleRun();
    const gas = createGas({ getRun: () => f.run });
    const p = gas.call('x');
    f.calls[0].ng({ message: 'ネットワークエラー' });
    await expect(p).rejects.toThrow('ネットワークエラー');
    const q = gas.call('y');
    f.calls[1].ng(new Error('権限切れ'));
    await expect(q).rejects.toThrow('権限切れ');
  });

  it('google.script.run が無いときは reject する', async () => {
    const gas = createGas({ getRun: () => undefined });
    await expect(gas.call('x')).rejects.toThrow();
  });

  it('存在しないサーバー関数でも枠を残さず reject する', async () => {
    const run = { withSuccessHandler: () => run, withFailureHandler: () => run } as unknown as GasRunner;
    const gas = createGas({ getRun: () => run });
    await expect(gas.call('nothing')).rejects.toThrow();
    expect(gas.stats().active).toBe(0);
  });
});

describe('gas: 同時実行数', () => {
  it('上限を超える呼び出しは順番待ちになり、空いたら発行される', async () => {
    const f = simpleRun();
    const gas = createGas({ getRun: () => f.run, limit: 2 });
    const ps = [gas.call('a'), gas.call('b'), gas.call('c'), gas.call('d')];
    expect(f.calls.map((c) => c.fn)).toEqual(['a', 'b']);
    expect(gas.stats()).toMatchObject({ active: 2, waiting: 2 });
    f.calls[0].ok(1);
    await ps[0];
    expect(f.calls.map((c) => c.fn)).toEqual(['a', 'b', 'c']);
    f.calls[1].ng(new Error('x'));
    await expect(ps[1]).rejects.toThrow();
    expect(f.calls.map((c) => c.fn)).toEqual(['a', 'b', 'c', 'd']);
    expect(gas.stats().maxActive).toBe(2);
    f.calls[2].ok(3);
    f.calls[3].ok(4);
    await Promise.all([ps[2], ps[3]]);
    expect(gas.stats()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('応答が返らない呼び出しは、一定時間で枠だけ返す（応答が来れば普通に届く）', async () => {
    vi.useFakeTimers();
    const f = simpleRun();
    const gas = createGas({ getRun: () => f.run, limit: 1, leaseMs: 1000 });
    const hung = gas.call('hung');
    const next = gas.call('next');
    expect(f.calls.map((c) => c.fn)).toEqual(['hung']);
    vi.advanceTimersByTime(1000);
    expect(f.calls.map((c) => c.fn)).toEqual(['hung', 'next']);
    f.calls[1].ok('n');
    await expect(next).resolves.toBe('n');
    // 遅れて応答が来ても届き、枠は二重に返らない
    f.calls[0].ok('late');
    await expect(hung).resolves.toBe('late');
    expect(gas.stats().active).toBe(0);
  });
});

describe('gas: 利用できるかの判定', () => {
  it('google.script.run が無ければ false、あれば true', () => {
    expect(isGasAvailable()).toBe(false);
    (globalThis as { google?: unknown }).google = { script: { run: {} } };
    expect(isGasAvailable()).toBe(true);
    (globalThis as { google?: unknown }).google = { script: {} };
    expect(isGasAvailable()).toBe(false);
  });
});

describe('isGasError', () => {
  it('error が文字列のオブジェクトだけを業務上の失敗とみなす', () => {
    expect(isGasError({ error: 'x' })).toBe(true);
    expect(isGasError({ success: true })).toBe(false);
    expect(isGasError(null)).toBe(false);
    expect(isGasError('error')).toBe(false);
    expect(isGasError({ error: 1 })).toBe(false);
  });
});

