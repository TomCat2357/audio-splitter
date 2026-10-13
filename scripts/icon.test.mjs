// gas/Code.gs のアイコン関連（iconNormalize_ / iconDestination_ / doGet）を確認する。
// iconNormalize_ は scripts/bundle-gas.mjs の normalizeIconUrl と同じ入力に同じ結果を返すこと（対応表テスト）。
import { describe, it, expect } from 'vitest';
import { load } from './helpers/load-code-gs.mjs';
import { normalizeIconUrl } from './bundle-gas.mjs';

const R = load().ctx;
const ID = 'A'.repeat(33);
const LH3 = 'https://lh3.googleusercontent.com/d/' + ID;
const E = { parameter: { a: 'root' }, parameters: { a: ['root'] } };
const NEW = 'https://script.google.com/macros/s/NEWID123/exec';

// 対応表の入力（正常系・異常系）
const TABLE = [
  // 空
  '', '   ', null, undefined,
  // Drive のファイル ID
  ID, '  ' + ID + '  ', ID + '#.ico', ID + '#.PNG', ID + '#.JPEG', ID + '#.gif', 'A'.repeat(19), 'A'.repeat(20), 'A'.repeat(200), 'A'.repeat(201),
  'a-b_c'.repeat(5), ID + '#.bmp', ID + '#', ID + '#.png#.ico',
  // Drive の共有 URL
  'https://drive.google.com/file/d/' + ID + '/view',
  'https://drive.google.com/file/d/' + ID + '/view?usp=sharing',
  'https://drive.google.com/file/d/' + ID,
  'https://drive.google.com/file/d/' + ID + '#.ico',
  'https://drive.google.com/file/d/' + ID + '/view#.JPG',
  'https://drive.google.com/file/d/' + ID + '/view#foo',
  'https://drive.google.com/open?id=' + ID,
  'https://drive.google.com/uc?export=view&id=' + ID,
  'https://drive.google.com/uc?id=' + ID + '&id=' + 'B'.repeat(30),
  'https://drive.google.com/uc?id=short&id=' + ID,
  'https://drive.google.com/uc?id=' + ID + '#.gif',
  'https://drive.google.com/uc?x=1#id=' + ID,
  'https://drive.google.com/uc?%69d=' + ID,
  'https://drive.google.com/uc?id=%41' + 'A'.repeat(29),
  'https://drive.google.com/uc?id=' + ID + '+',
  'https://drive.google.com/uc?id=',
  'https://drive.google.com/uc?id',
  'https://drive.google.com/',
  'https://drive.google.com',
  'https://drive.google.com/file/d/short/view',
  'https://drive.google.com/x/file/d/' + ID + '/view',
  'https://drive.google.com/file/d/' + ID + 'x/view',
  'https://drive.google.com/file/d/' + ID + '%2Fview',
  'https://drive.google.com/a/../file/d/' + ID,
  'https://drive.google.com/file/d/' + ID + '/../x',
  'https://drive.google.com/file/d/' + ID + '/./view',
  'https://drive.google.com/file/d/' + ID + '/%2e%2e/%2E',
  'https://docs.google.com/file/d/' + ID + '/edit',
  'https://docs.google.com/uc?id=' + ID,
  'HTTPS://DRIVE.GOOGLE.COM/file/d/' + ID + '/view',
  'https://Drive.Google.Com/file/d/' + ID + '/view',
  'https://drive.google.com:443/file/d/' + ID + '/view',
  'https://drive.google.com:8443/file/d/' + ID + '/view',
  'https://drive.google.com:/file/d/' + ID + '/view',
  'https://drive.google.com:99999/file/d/' + ID + '/view',
  'https://drive.google.com:abc/file/d/' + ID + '/view',
  'https://user@drive.google.com/file/d/' + ID + '/view',
  'https://user:pw@drive.google.com:443/file/d/' + ID + '/view',
  'https://user@/file/d/' + ID,
  'https:///drive.google.com/file/d/' + ID + '/view',
  'https://drive.google.com./file/d/' + ID + '/view',
  'https://%64rive.google.com/file/d/' + ID + '/view',
  'https://drive.google.com.evil.example/file/d/' + ID + '/view',
  'https://evildrive.google.com/file/d/' + ID + '/view',
  'https://evil.example/drive.google.com/file/d/' + ID,
  'http://drive.google.com/file/d/' + ID + '/view',
  // 一般の https URL
  'https://example.com/icon.png',
  'https://example.com/icon.PNG',
  'https://example.com/icon.ico',
  'https://example.com/icon.jpeg?x=1',
  'https://example.com/icon.gif',
  'https://example.com/icon',
  'https://example.com',
  'https://example.com/',
  'https://example.com/icon?v=1',
  'https://example.com/icon#.ico',
  'https://example.com/icon#.ICO',
  'https://example.com/icon.png#.ico',
  'https://example.com/icon#foo',
  'https://example.com/icon.png#foo',
  'https://example.com/icon#',
  'https://example.com/a#b#.png',
  'https://example.com/icon#.bmp',
  'https://example.com/icon.bmp',
  'HTTPS://EXAMPLE.COM/Icon',
  'https://example.com:8443/icon',
  'https://example.com:/icon',
  'https://example.com:65535/icon',
  'https://example.com:65536/icon',
  'https://example.com:0/icon',
  'https://example.com:8a/icon',
  'https://example.com:1:2/icon',
  'https://user:pw@example.com/icon',
  'https://user@example.com:8443/icon',
  'https://a@b@example.com/icon',
  'https://@example.com/icon',
  'https://:@example.com/icon',
  'https://example.com@/icon',
  'https:///example.com/icon',
  'https:////example.com/icon',
  'https://',
  'https://#.png',
  'https:///',
  'https://:80/icon',
  'https://?x',
  'https://#x',
  'https://example..com/icon',
  'https://example.com./icon',
  'https://-example.com/icon',
  'https://exa_mple.com/icon',
  'https://exa%6dple.com/icon',
  'https://exa%zzple.com/icon',
  'https://exa%25ple.com/icon',
  'https://exa|mple.com/icon',
  'https://exa^mple.com/icon',
  'https://exa{mple}.com/icon',
  'https://exa`mple.com/icon',
  'https://exa*mple.com/icon',
  'https://exa[mple.com/icon',
  'https://exa]mple.com/icon',
  'https://exa<mple.com/icon',
  'https://exa mple.com/icon',
  'https://exa\\mple.com/icon',
  // IP アドレス
  'https://192.168.0.1/icon',
  'https://192.168.0.1:8080/icon.png',
  'https://256.256.256.256/icon',
  'https://1.2.3.256/icon',
  'https://1.2.3.4.5/icon',
  'https://1.2.3.4./icon',
  'https://999/icon',
  'https://4294967295/icon',
  'https://4294967296/icon',
  'https://0x7f.1/icon',
  'https://0x7f.0.0.1/icon',
  'https://0x/icon',
  'https://0x1g/icon',
  'https://0300.0250.0.1/icon',
  'https://08.1/icon',
  'https://1.2.3/icon',
  'https://1.2.3.4a/icon',
  'https://a.1/icon',
  'https://1.a/icon',
  'https://[::1]/icon',
  'https://[::1]:8080/icon.png',
  'https://[::1/icon',
  'https://[]/icon',
  'https://[abc]/icon',
  'https://[::1]x/icon',
  'https://[1::2::3]/icon',
  'https://[::ffff:1.2.3.4]/icon',
  'https://[1:2:3:4:5:6:7:8]/icon',
  'https://[1:2:3:4:5:6:7:8:9]/icon',
  'https://[::1.2.3.256]/icon',
  'https://[:1]/icon',
  'https://[12345::]/icon',
  'https://exa%C3%A9mple.com/icon',
  // 文字・長さ
  'https://example.com/a b',
  'https://example.com/a"b',
  "https://example.com/a'b",
  'https://example.com/a\\b',
  'https://example.com/a<b>',
  'https://example.com/a`b',
  'https://example.com/あ',
  'https://example.com/a%20b',
  'https://example.com/a{b}|^',
  'https://example.com/' + 'a'.repeat(1970),
  'https://example.com/' + 'a'.repeat(1979),
  'https://example.com/' + 'a'.repeat(1980),
  'https://example.com/' + 'a'.repeat(1990),
  'https://example.com/' + 'a'.repeat(1995) + '.png',
  'https://example.com/' + 'a'.repeat(1981) + '#.ico',
  // 別の形
  'http://example.com/icon.png',
  'ftp://example.com/icon.png',
  'javascript:alert(1)',
  'data:image/png;base64,AAAA',
  'example.com/icon.png',
  '//example.com/icon.png',
  '/icon.png',
  'icon.png',
  '#.png',
  'not a url',
  'https:example.com/icon',
  'https:/example.com/icon',
];

describe('iconNormalize_ と normalizeIconUrl の対応表', () => {
  it('同じ入力に同じ結果（正常なら同じ文字列、normalizeIconUrl が例外なら null、空なら空文字）', () => {
    const diffs = [];
    let ok = 0;
    let ng = 0;
    for (const v of TABLE) {
      let expected;
      try { expected = normalizeIconUrl(v); } catch { expected = null; }
      const actual = R.iconNormalize_(v);
      if (expected === null) ng++; else ok++;
      if (actual !== expected) diffs.push({ input: String(v).slice(0, 80), expected, actual });
    }
    expect(diffs).toEqual([]);
    // 表が正常系・異常系の両方を十分に含むこと
    expect(ok).toBeGreaterThan(40);
    expect(ng).toBeGreaterThan(60);
  });
  it('正規化の出力は、もう一度通しても変わらない（長さ上限を超える出力を除く）', () => {
    for (const v of TABLE) {
      let out;
      try { out = normalizeIconUrl(v); } catch { continue; }
      if (out.length > 2000) continue;
      expect(R.iconNormalize_(out), String(v).slice(0, 80)).toBe(out);
    }
  });
  it('代表例', () => {
    expect(R.iconNormalize_(ID)).toBe(LH3 + '#.png');
    expect(R.iconNormalize_('https://drive.google.com/file/d/' + ID + '/view#.ico')).toBe(LH3 + '#.ico');
    expect(R.iconNormalize_('https://example.com/icon')).toBe('https://example.com/icon#.png');
    expect(R.iconNormalize_('http://example.com/icon.png')).toBeNull();
    expect(R.iconNormalize_('  ')).toBe('');
  });
});

describe('iconDestination_（優先順位: プロパティ > 焼き込み。off で解除）', () => {
  const D = (p, b) => R.iconDestination_(p, b);
  const BAKED = 'https://example.com/baked.png';
  it('どちらも空なら空', () => {
    expect(D(null, '')).toBe('');
    expect(D(undefined, undefined)).toBe('');
    expect(D('  ', '  ')).toBe('');
  });
  it('焼き込みだけなら焼き込み、プロパティがあれば正規化したプロパティ', () => {
    expect(D(null, BAKED)).toBe(BAKED);
    expect(D('', BAKED)).toBe(BAKED);
    expect(D('https://example.com/prop.ico', BAKED)).toBe('https://example.com/prop.ico');
    expect(D(' https://example.com/prop ', BAKED)).toBe('https://example.com/prop#.png');
    expect(D(ID, '')).toBe(LH3 + '#.png');
    expect(D('https://drive.google.com/file/d/' + ID + '/view', BAKED)).toBe(LH3 + '#.png');
  });
  it('off は焼き込みがあっても解除（大文字小文字・空白は無視）', () => {
    expect(D('off', BAKED)).toBe('');
    expect(D(' OFF ', BAKED)).toBe('');
    expect(D('Off', '')).toBe('');
  });
  it('不正なプロパティ値は焼き込みに戻らず空（iconPropInvalid_ で判別できる）', () => {
    expect(D('garbage', BAKED)).toBe('');
    expect(D('http://example.com/a.png', BAKED)).toBe('');
    expect(R.iconPropInvalid_('garbage')).toBe(true);
    ['', '  ', null, undefined, 'off', ' OFF ', ID, 'https://example.com/a.png'].forEach((v) => expect(R.iconPropInvalid_(v), String(v)).toBe(false));
  });
});

describe('doGet のアイコン', () => {
  const BAKED = 'https://example.com/baked.png';
  it('焼き込みだけ → 焼き込み値で setFaviconUrl', () => {
    const { ctx, calls } = load({ icon: BAKED });
    expect(ctx.doGet(E).kind).toBe('file');
    expect(calls.favicon).toEqual([BAKED]);
  });
  it('プロパティが焼き込みより優先される', () => {
    const { ctx, calls } = load({ icon: BAKED, iconProp: 'https://example.com/prop.ico' });
    ctx.doGet(E);
    expect(calls.favicon).toEqual(['https://example.com/prop.ico']);
  });
  it('プロパティが off なら焼き込みがあっても付けない（OFF・前後の空白つきも）', () => {
    for (const v of ['off', 'OFF', '  Off  ']) {
      const { ctx, calls } = load({ icon: BAKED, iconProp: v });
      expect(ctx.doGet(E).kind).toBe('file');
      expect(calls.favicon, v).toHaveLength(0);
      expect(calls.errors, v).toHaveLength(0);
    }
  });
  it('プロパティが不正なら付けない・焼き込みに戻らない・ログに値を出さない', () => {
    const bad = 'http://secret.example.com/not-allowed.png';
    const { ctx, calls } = load({ icon: BAKED, iconProp: bad });
    expect(ctx.doGet(E).kind).toBe('file');
    expect(calls.favicon).toHaveLength(0);
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toContain('AUDIO_SPLITTER_ICON_URL');
    expect(calls.errors[0]).not.toContain('secret.example.com');
    expect(calls.errors[0]).not.toContain(bad);
  });
  it('プロパティに Drive のファイル ID や共有 URL → lh3 の URL で呼ばれる', () => {
    const a = load({ iconProp: ID });
    a.ctx.doGet(E);
    expect(a.calls.favicon).toEqual([LH3 + '#.png']);
    const b = load({ icon: BAKED, iconProp: 'https://drive.google.com/file/d/' + ID + '/view#.ico' });
    b.ctx.doGet(E);
    expect(b.calls.favicon).toEqual([LH3 + '#.ico']);
  });
  it('プロパティ取得で例外 → 焼き込み値が使われる', () => {
    const { ctx, calls } = load({ icon: BAKED, throwsIconProps: true });
    expect(ctx.doGet(E).kind).toBe('file');
    expect(calls.favicon).toEqual([BAKED]);
    expect(calls.errors).toHaveLength(0);
  });
  it('プロパティも焼き込みも空 → 呼ばれない', () => {
    const { ctx, calls } = load();
    ctx.doGet(E);
    expect(calls.favicon).toHaveLength(0);
    expect(calls.errors).toHaveLength(0);
  });
  it('setFaviconUrl が例外でも HtmlOutput を返す', () => {
    const { ctx, calls } = load({ iconProp: BAKED, faviconThrows: true });
    const out = ctx.doGet(E);
    expect(out.kind).toBe('file');
    expect(out.title).toBe('音声分割');
    expect(calls.errors).toHaveLength(1);
  });
  it('リダイレクトが成立するときは従来どおり案内ページ（アイコンは付けない・index は読まない）', () => {
    const { ctx, calls } = load({ baked: NEW, iconProp: BAKED });
    expect(ctx.doGet(E).kind).toBe('string');
    expect(calls.file).toHaveLength(0);
    expect(calls.favicon).toHaveLength(0);
  });
});
