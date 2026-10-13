// gas/Redirect.gs（と gas/Code.gs の doGet）を node:vm で読み込み、GAS のサービスを模擬して確認する。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { bakeCodeGs } from './bundle-gas.mjs';

const GAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gas');
const read = (n) => fs.readFileSync(path.join(GAS_DIR, n), 'utf8');

/** env: { prop, baked, icon, throwsProps, faviconThrows } */
function load(env = {}) {
  const calls = { file: [], html: [], favicon: [], scriptApp: 0 };
  const makeOut = (kind) => {
    const o = {
      kind,
      title: null,
      setTitle(t) { o.title = t; return o; },
      addMetaTag() { return o; },
      setXFrameOptionsMode() { return o; },
      setFaviconUrl(u) { if (env.faviconThrows) throw new Error('bad favicon'); calls.favicon.push(u); return o; },
    };
    return o;
  };
  const ctx = vm.createContext({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => {
          if (env.throwsProps) throw new Error('props');
          return k === 'AUDIO_SPLITTER_REDIRECT_URL' && env.prop !== undefined ? env.prop : null;
        },
      }),
    },
    ScriptApp: { getService: () => { calls.scriptApp++; throw new Error('getUrl は呼ばない'); } },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 1 },
      createHtmlOutput(html) { calls.html.push(html); const o = makeOut('string'); o.html = html; return o; },
      createHtmlOutputFromFile(name) { calls.file.push(name); return makeOut('file'); },
    },
    console: { error() {} },
  });
  const code = bakeCodeGs(read('Code.gs'), { iconUrl: env.icon ?? '', redirectUrl: env.baked ?? '' });
  vm.runInContext(code, ctx, { filename: 'Code.gs' });
  vm.runInContext(read('Redirect.gs'), ctx, { filename: 'Redirect.gs' });
  return { ctx, calls };
}

const R = load().ctx;
const NEW = 'https://script.google.com/macros/s/NEWID123/exec';
const NEWER = 'https://script.google.com/macros/s/NEWERID789/exec';
const NEWQ = NEW + '?redirect_target=NEWID123';

describe('redirectDeployId_', () => {
  it('ドメイン付き・無し、exec・dev、クエリ付き、前後の空白', () => {
    expect(R.redirectDeployId_('https://script.google.com/macros/s/AKfy-_cd9/exec')).toBe('AKfy-_cd9');
    expect(R.redirectDeployId_('https://script.google.com/a/macros/example.test/s/AKfy-_cd9/exec')).toBe('AKfy-_cd9');
    expect(R.redirectDeployId_('https://script.google.com/a/example.test/macros/s/AKfy-_cd9/dev')).toBe('AKfy-_cd9');
    expect(R.redirectDeployId_('https://script.google.com/macros/s/AKfy-_cd9/exec?url1=root#x')).toBe('AKfy-_cd9');
    expect(R.redirectDeployId_('  https://script.google.com/macros/s/AKfy-_cd9  ')).toBe('AKfy-_cd9');
  });
  it('不正値は null', () => {
    [null, undefined, '', 'garbage', 'http://script.google.com/macros/s/X/exec', 'https://evil.example/macros/s/X/exec',
      'https://script.google.com/macros/s//exec', 'https://script.google.com/', 'https://script.google.com.evil.example/macros/s/X/exec']
      .forEach((v) => expect(R.redirectDeployId_(v), String(v)).toBeNull());
  });
});

describe('redirectTarget_', () => {
  it('移動先 + redirect_target=<ID> を返す（クエリ・ハッシュは捨てる）', () => {
    expect(R.redirectTarget_({ parameter: {} }, NEW)).toBe(NEWQ);
    expect(R.redirectTarget_({ parameter: {} }, NEW + '?x=1#h')).toBe(NEWQ);
    expect(R.redirectTarget_(undefined, NEW)).toBe(NEWQ);
  });
  it('未設定・空・不正 URL は何もしない', () => {
    [undefined, null, '', '   '].forEach((v) => expect(R.redirectTarget_({ parameter: {} }, v)).toBeNull());
    expect(R.redirectTarget_({ parameter: {} }, 'not a url')).toBeNull();
    expect(R.redirectTarget_({ parameter: {} }, 'https://evil.example/macros/s/NEWID123/exec')).toBeNull();
    expect(R.redirectTarget_({ parameter: {} }, 'javascript:alert(1)')).toBeNull();
    expect(R.redirectTarget_({ parameter: {} }, 'https://script.google.com/macros/exec')).toBeNull();
  });
  it('noredirect=1 では移動しない（0 などは無視して移動）', () => {
    expect(R.redirectTarget_({ parameter: { noredirect: '1' } }, NEW)).toBeNull();
    expect(R.redirectTarget_({ parameter: { noredirect: ' 1 ' } }, NEW)).toBeNull();
    expect(R.redirectTarget_({ parameter: { noredirect: '0' }, parameters: { noredirect: ['0'] } }, NEW)).toBe(NEWQ);
  });
  it('redirect_target が移動先 ID と一致すれば移動しない（ループ防止）。違えば今の移動先へ追従', () => {
    expect(R.redirectTarget_({ parameter: { redirect_target: 'NEWID123' } }, NEW)).toBeNull();
    expect(R.redirectTarget_({ parameter: { redirect_target: ' NEWID123 ' } }, NEW)).toBeNull();
    expect(R.redirectTarget_({ parameter: { redirect_target: 'NEWID123', a: '1' }, parameters: { redirect_target: ['NEWID123'], a: ['1'] } }, NEWER))
      .toBe(NEWER + '?a=1&redirect_target=NEWERID789');
    expect(R.redirectTarget_({ parameter: { redirect_target: 'NEWERID789' } }, NEWER)).toBeNull();
    expect(R.redirectTarget_({ parameter: { redirect_target: '' } }, NEW)).toBe(NEWQ);
    expect(R.redirectTarget_({ parameter: { redirect_target: 'newid123' } }, NEW)).toBe(NEWQ);
    expect(R.redirectTarget_({ parameter: { noredirect: '1', redirect_target: 'OTHER' } }, NEW)).toBeNull();
  });
  it('起動時クエリを引き継ぐ（noredirect・redirect_target は除き、redirect_target は 1 つだけ）', () => {
    expect(R.redirectQuery_({ parameters: { a: ['root/フォルダ A&B=1'], b: ['x', 'y'] } })).toBe('a=root%2F%E3%83%95%E3%82%A9%E3%83%AB%E3%83%80%20A%26B%3D1&b=x&b=y');
    expect(R.redirectQuery_({ parameter: { a: 'x y' } })).toBe('a=x%20y');
    expect(R.redirectQuery_({})).toBe('');
    expect(R.redirectQuery_(null)).toBe('');
    const t = R.redirectTarget_({ parameters: { a: ['1'], noredirect: ['0'], redirect_target: ['OLDID456'] } }, NEW);
    expect(t).toBe(NEW + '?a=1&redirect_target=NEWID123');
    expect(t.match(/redirect_target=/g)).toHaveLength(1);
  });
});

describe('redirectPageHtml_', () => {
  it('HTML・JS 文字列のエスケープ、_top のリンク、アプリ名', () => {
    const evil = 'https://script.google.com/macros/s/N/exec?a=<script>"&\'</script>\u2028';
    const html = R.redirectPageHtml_(evil);
    expect(html).toContain('<title>音声分割</title>');
    expect(html).toContain('target="_top"');
    expect(html).toContain('href="https://script.google.com/macros/s/N/exec?a=&lt;script&gt;&quot;&amp;&#39;&lt;/script&gt;\u2028"');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const js = html.slice(html.lastIndexOf('<script>'));
    expect(js).toContain('window.top.location.href="https://script.google.com/macros/s/N/exec?a=\\u003cscript\\u003e\\"\\u0026\'\\u003c/script\\u003e\\u2028"');
  });
});

describe('redirectDestination_（優先順位: プロパティ > 焼き込み。off で解除）', () => {
  const D = R.redirectDestination_;
  it('どちらも空なら空', () => {
    expect(D(null, '')).toBe('');
    expect(D(undefined, undefined)).toBe('');
    expect(D('  ', '  ')).toBe('');
  });
  it('焼き込みだけなら焼き込み、プロパティがあればプロパティ', () => {
    expect(D(null, NEW)).toBe(NEW);
    expect(D('', NEW)).toBe(NEW);
    expect(D(NEWER, NEW)).toBe(NEWER);
    expect(D(' ' + NEWER + ' ', '')).toBe(NEWER);
  });
  it('off は焼き込みがあっても解除（大文字小文字・空白は無視）', () => {
    expect(D('off', NEW)).toBe('');
    expect(D(' OFF ', NEW)).toBe('');
    expect(D('Off', '')).toBe('');
  });
  it('不正なプロパティ値は焼き込みに戻さず、そのまま返す（redirectTarget_ が null にする）', () => {
    expect(D('garbage', NEW)).toBe('garbage');
    expect(R.redirectTarget_({ parameter: {} }, D('garbage', NEW))).toBeNull();
  });
});

describe('redirectResponse_ / doGet', () => {
  const e = { parameter: { a: 'root' }, parameters: { a: ['root'] } };
  it('どちらも未設定なら移動しない', () => {
    const { ctx, calls } = load();
    expect(ctx.redirectResponse_(e)).toBeNull();
    expect(calls.html).toHaveLength(0);
  });
  it('焼き込みだけ → 焼き込み先へ案内ページ（getUrl は呼ばない）', () => {
    const { ctx, calls } = load({ baked: NEW });
    const out = ctx.redirectResponse_(e);
    expect(out.html).toContain('href="' + NEW + '?a=root&amp;redirect_target=NEWID123"');
    expect(out.title).toBe('音声分割');
    expect(calls.scriptApp).toBe(0);
  });
  it('プロパティが焼き込みより優先される', () => {
    const out = load({ baked: NEW, prop: NEWER }).ctx.redirectResponse_(e);
    expect(out.html).toContain('redirect_target=NEWERID789');
    expect(out.html).not.toContain('NEWID123');
  });
  it('プロパティが off なら焼き込みがあっても移動しない', () => {
    expect(load({ baked: NEW, prop: 'off' }).ctx.redirectResponse_(e)).toBeNull();
  });
  it('プロパティが不正なら移動しない（焼き込みには戻さない）', () => {
    expect(load({ baked: NEW, prop: 'https://evil.example/macros/s/X/exec' }).ctx.redirectResponse_(e)).toBeNull();
  });
  it('プロパティだけでも動く', () => {
    expect(load({ prop: NEW }).ctx.redirectResponse_(e)).toBeTruthy();
  });
  it('noredirect=1 / redirect_target 一致 / 不一致', () => {
    const { ctx } = load({ baked: NEW });
    expect(ctx.redirectResponse_({ parameter: { noredirect: '1' } })).toBeNull();
    expect(ctx.redirectResponse_({ parameter: { redirect_target: 'NEWID123' } })).toBeNull();
    expect(ctx.redirectResponse_({ parameter: { redirect_target: 'OLDID456' } })).toBeTruthy();
  });
  it('プロパティ取得で例外が出ても焼き込みで動き、例外は投げない', () => {
    expect(load({ baked: NEW, throwsProps: true }).ctx.redirectResponse_(e)).toBeTruthy();
    expect(load({ throwsProps: true }).ctx.redirectResponse_(e)).toBeNull();
  });
  it('doGet: 移動しなければ Index をファイルから返す（createHtmlOutput で作り直さない）', () => {
    const { ctx, calls } = load();
    const out = ctx.doGet(e);
    expect(out.kind).toBe('file');
    expect(calls.file).toEqual(['Index']);
    expect(calls.html).toHaveLength(0);
    expect(out.title).toBe('音声分割');
    expect(calls.favicon).toHaveLength(0);
  });
  it('doGet: 移動するなら案内ページ、Index は読まない', () => {
    const { ctx, calls } = load({ baked: NEW });
    expect(ctx.doGet(e).kind).toBe('string');
    expect(calls.file).toHaveLength(0);
  });
  it('doGet: アイコンが焼き込まれていれば setFaviconUrl、失敗しても画面は返す', () => {
    const a = load({ icon: 'https://example.test/i.png' });
    a.ctx.doGet(e);
    expect(a.calls.favicon).toEqual(['https://example.test/i.png']);
    const b = load({ icon: 'https://example.test/i.png', faviconThrows: true });
    expect(b.ctx.doGet(e).kind).toBe('file');
  });
});
