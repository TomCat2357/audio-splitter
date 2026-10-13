// google.script.run の偽物。src/lib/gas.ts の createGas({ getRun }) に渡すと、
//   withSuccessHandler(cb).withFailureHandler(cb).関数名(引数...)
// の形で、本物の Code.gs（createServer が返すもの）を呼ぶ。
//
// 本物の google.script.run を真似る点:
//   - 非同期（呼び出しは別の実行になり、応答は後から届く）。実行ごとに新しいグローバル（createServer().newContext()）。
//   - 引数と戻り値は JSON として往復する（JSON.parse(JSON.stringify(...))）。関数・undefined・Date・NaN などは正しく渡らないので、
//     往復の前に検査して violations に記録する（テストが空であることを確認する）。
//   - 末尾が _ の関数・存在しない関数は「Script function not found」で失敗ハンドラへ。
//   - サーバー関数が例外を投げたら失敗ハンドラへ（Error）。
import { createGas } from '../../src/lib/gas.ts';

const tag = (v) => Object.prototype.toString.call(v);

/** JSON で正しく渡らない値を探す。[{ path, kind }] */
export function scanIllegal(value, base = '$') {
  const out = [];
  const walk = (v, p) => {
    if (v === undefined) return out.push({ path: p, kind: 'undefined' });
    if (v === null) return;
    const t = typeof v;
    if (t === 'function' || t === 'symbol' || t === 'bigint') return out.push({ path: p, kind: t });
    if (t === 'number') {
      if (!Number.isFinite(v)) out.push({ path: p, kind: 'non-finite-number' });
      return;
    }
    if (t === 'string' || t === 'boolean') return;
    const g = tag(v);
    if (g === '[object Array]') return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (g === '[object Object]') return Object.keys(v).forEach((k) => walk(v[k], `${p}.${k}`));
    out.push({ path: p, kind: g }); // Date / Map / Set / Buffer / 型付き配列 など
  };
  walk(value, base);
  return out;
}

const summarize = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 120 ? `<string ${x.length}>` : x));

/**
 * opts:
 *   hook(rec)   サーバーを呼ぶ前に呼ばれる（await される）。rec = { fn, args, index }。
 *               'drop-request' を返すとサーバーを実行せず失敗ハンドラへ、'drop-response' を返すと
 *               サーバーを実行したうえで応答を失わせる（失敗ハンドラへ。サーバー側の変更は残る）。
 *   limit       createGas の同時実行数（既定 6）
 */
export function createFakeGas(server, opts = {}) {
  const log = []; // { fn, args(要約), result(要約), error, index }
  const violations = [];
  const counts = new Map();
  const nextIndex = (fn) => { const n = (counts.get(fn) || 0) + 1; counts.set(fn, n); return n; };

  async function exec(fn, rawArgs, ok, ng) {
    const index = nextIndex(fn);
    const entry = { fn, index, args: null, result: undefined, error: undefined };
    log.push(entry);
    try {
      for (const v of scanIllegal(rawArgs, 'args')) violations.push({ where: 'args', fn, ...v });
      const args = JSON.parse(JSON.stringify(rawArgs));
      entry.args = summarize(args);
      const decision = opts.hook ? await opts.hook({ fn, args, index }) : undefined;
      if (decision === 'drop-request') throw new Error('通信エラー（要求が届かなかった）');
      let ctx;
      let f;
      try {
        ctx = server.newContext();
        f = ctx[fn];
      } catch (e) {
        throw e;
      }
      if (fn.endsWith('_') || typeof f !== 'function') throw new Error(`Script function not found: ${fn}`);
      const raw = f(...args);
      for (const v of scanIllegal(raw, 'result')) violations.push({ where: 'result', fn, ...v });
      const result = JSON.parse(JSON.stringify(raw === undefined ? null : raw));
      entry.result = summarize(result);
      if (decision === 'drop-response') throw new Error('通信エラー（応答が届かなかった）');
      ok(result);
    } catch (e) {
      entry.error = e && e.message ? e.message : String(e);
      // サーバー関数の例外は Error として失敗ハンドラへ
      ng(e instanceof Error ? e : new Error(String(e)));
    }
  }

  function builder(ok, ng) {
    return new Proxy(
      {},
      {
        get(_, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop === 'withSuccessHandler') return (cb) => builder(cb, ng);
          if (prop === 'withFailureHandler') return (cb) => builder(ok, cb);
          return (...args) => {
            setTimeout(() => { void exec(prop, args, ok || (() => {}), ng || (() => {})); }, 0);
          };
        },
      },
    );
  }

  const run = builder(null, null);
  const gas = createGas({ getRun: () => run, limit: opts.limit ?? 6 });
  return {
    run,
    /** src/lib/gas.ts の createGas().call（画面側の gasCall と同じもの） */
    call: gas.call,
    stats: gas.stats,
    log,
    violations,
    count: (fn) => log.filter((l) => l.fn === fn).length,
    names: () => log.map((l) => l.fn),
  };
}
