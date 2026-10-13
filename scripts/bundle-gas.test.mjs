import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeIconUrl, normalizeRedirectUrl, bundleGas, insertBaseTag, parseArgs, resolveWebapp, buildManifest, planDeploy } from './bundle-gas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_GAS_DIR = path.join(HERE, '..', 'gas');
const FAKE_ID = 'FAKEFILEID0123456789abcdefg';
const FAKE_ICON = 'https://lh3.googleusercontent.com/d/' + FAKE_ID + '#.png';
const DEST = 'https://script.google.com/macros/s/FAKEDEPLOYID123/exec';

describe('normalizeIconUrl', () => {
  const n = normalizeIconUrl;
  it('Drive の共有 URL / ファイル ID は lh3 の URL（末尾 #.png）に変換する', () => {
    expect(n('https://drive.google.com/file/d/' + FAKE_ID + '/view?usp=sharing')).toBe(FAKE_ICON);
    expect(n('https://drive.google.com/file/d/' + FAKE_ID)).toBe(FAKE_ICON);
    expect(n('https://drive.google.com/open?id=' + FAKE_ID)).toBe(FAKE_ICON);
    expect(n('https://drive.google.com/uc?export=view&id=' + FAKE_ID)).toBe(FAKE_ICON);
    expect(n('  ' + FAKE_ID + ' ')).toBe(FAKE_ICON);
  });
  it('それ以外の https URL は必要なときだけ #.png を足す', () => {
    expect(n('https://example.com/icon.ico')).toBe('https://example.com/icon.ico');
    expect(n('https://example.com/Icon.PNG')).toBe('https://example.com/Icon.PNG');
    expect(n('https://example.com/open?id=' + FAKE_ID)).toBe('https://example.com/open?id=' + FAKE_ID + '#.png');
    expect(n('https://example.com/icon.png?v=2')).toBe('https://example.com/icon.png?v=2#.png');
  });
  it('末尾の #.拡張子 を尊重する', () => {
    expect(n(FAKE_ID + '#.ico')).toBe('https://lh3.googleusercontent.com/d/' + FAKE_ID + '#.ico');
    expect(n('https://drive.google.com/file/d/' + FAKE_ID + '/view#.JPG')).toBe('https://lh3.googleusercontent.com/d/' + FAKE_ID + '#.jpg');
    expect(n('https://drive.google.com/file/d/' + FAKE_ID + '/view#heading')).toBe(FAKE_ICON);
    expect(n('https://example.com/icon#.ico')).toBe('https://example.com/icon#.ico');
  });
  it('空は空', () => {
    expect(n('')).toBe('');
    expect(n(undefined)).toBe('');
    expect(n('   ')).toBe('');
  });
  it('不正な値は日本語メッセージの例外', () => {
    expect(() => n('http://example.com/a.png')).toThrow(/https/);
    expect(() => n('short-id')).toThrow(/https/);
    expect(() => n('bad url')).toThrow(/https/);
    expect(() => n('https://example.com/a b.png')).toThrow(/使えない文字/);
    expect(() => n("https://example.com/a'.png")).toThrow(/使えない文字/);
    expect(() => n('https://example.com/a".png')).toThrow(/使えない文字/);
    expect(() => n('https://example.com/<a>.png')).toThrow(/使えない文字/);
    expect(() => n('https://example.com/icon#x')).toThrow(/#\.png/);
    expect(() => n('https://example.com/icon#.webp')).toThrow(/#\.png/);
    expect(() => n('https://drive.google.com/drive/folders/' + FAKE_ID)).toThrow(/ファイル ID/);
    expect(() => n('https://drive.google.com/file/d/short/view')).toThrow(/ファイル ID/);
  });
});

describe('normalizeRedirectUrl', () => {
  const n = normalizeRedirectUrl;
  it('空は空、正しい URL はそのまま（前後の空白は除く）', () => {
    expect(n('')).toBe('');
    expect(n(undefined)).toBe('');
    expect(n('  ')).toBe('');
    expect(n(DEST)).toBe(DEST);
    expect(n('  ' + DEST + '  ')).toBe(DEST);
    expect(n('https://script.google.com/a/macros/example.test/s/FAKEID/exec')).toBe('https://script.google.com/a/macros/example.test/s/FAKEID/exec');
    expect(n('https://script.google.com/a/example.test/macros/s/FAKEID/exec')).toBe('https://script.google.com/a/example.test/macros/s/FAKEID/exec');
  });
  it('script.google.com 以外・ID を取れない形は例外', () => {
    expect(() => n('http://script.google.com/macros/s/X/exec')).toThrow(/script\.google\.com/);
    expect(() => n('https://example.com/macros/s/X/exec')).toThrow(/script\.google\.com/);
    expect(() => n('https://script.google.com.evil.test/macros/s/X/exec')).toThrow(/script\.google\.com/);
    expect(() => n('javascript:alert(1)')).toThrow(/script\.google\.com/);
    expect(() => n('FAKEDEPLOYID123')).toThrow(/script\.google\.com/);
    expect(() => n('https://script.google.com/')).toThrow(/デプロイ ID/);
    expect(() => n('https://script.google.com/macros/s//exec')).toThrow(/デプロイ ID/);
    expect(() => n('https://script.google.com/macros/exec')).toThrow(/デプロイ ID/);
  });
  it('GAS のソースに埋め込むと危険な文字は例外', () => {
    for (const bad of ["'", '"', ' ', '\\', '<', '>', '\n', ' ']) {
      expect(() => n('https://script.google.com/macros/s/X' + bad + 'Y/exec'), JSON.stringify(bad)).toThrow(/使えない文字/);
    }
  });
});

describe('insertBaseTag', () => {
  it('<head> 直後に入れ、二重には入れない', () => {
    const once = insertBaseTag('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
    expect(once).toContain('<head><base target="_top"><meta');
    expect(insertBaseTag(once)).toBe(once);
  });
  it('属性付きの <head lang> にも入れ、<header> には反応しない', () => {
    expect(insertBaseTag('<html><head data-x="1"><title>t</title></head></html>')).toContain('<head data-x="1"><base target="_top">');
    expect(() => insertBaseTag('<html><header></header></html>')).toThrow(/head/);
  });
});

describe('parseArgs', () => {
  it('--key value と --key=value', () => {
    expect(parseArgs(['--icon-url', 'a', '--redirect-url=b'])).toEqual({ iconUrl: 'a', redirectUrl: 'b' });
    expect(parseArgs(['--execute-as=deploying', '--access', 'anonymous', '--plan'])).toEqual({ executeAs: 'deploying', access: 'anonymous', plan: true });
    expect(() => parseArgs(['--nope', 'x'])).toThrow(/不明/);
    expect(() => parseArgs(['--icon-url'])).toThrow(/値がありません/);
  });
});

describe('bundleGas（一時ディレクトリ）', () => {
  let tmp, gasDir, distDir, gasSnapshot;
  const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
  const run = (o = {}) => bundleGas({ gasDir, distDir, env: {}, ...o });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gas-test-'));
    gasDir = path.join(tmp, 'gas');
    distDir = path.join(tmp, 'dist');
    // fs.cpSync は Windows の Node で本プロジェクトのパス（OneDrive 配下・日本語）に対しワーカーごと落ちることがあったため、1 ファイルずつコピーする
    fs.mkdirSync(gasDir);
    for (const n of fs.readdirSync(REAL_GAS_DIR)) fs.writeFileSync(path.join(gasDir, n), fs.readFileSync(path.join(REAL_GAS_DIR, n)));
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body>音声</body></html>', 'utf8');
    gasSnapshot = snapshot(gasDir);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('プレースホルダーを置換し、index.html に base を入れ、appsscript.json と .gs を出力する', () => {
    const r = run({ iconUrl: FAKE_ID, redirectUrl: DEST });
    const code = fs.readFileSync(path.join(distDir, 'Code.gs'), 'utf8');
    expect(code).toContain(`var APP_ICON_URL_ = '${FAKE_ICON}';`);
    expect(code).toContain(`var REDIRECT_URL_ = '${DEST}';`);
    expect(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')).toContain('<head><base target="_top">');
    expect(code).toContain('function doGet(');
    expect(code).toContain('function redirectResponse_(');
    expect(fs.readFileSync(path.join(distDir, 'appsscript.json'), 'utf8')).toBe(gasSnapshot['appsscript.json']);
    expect(r.iconBaked && r.redirectBaked).toBe(true);
    expect(r.files.map((f) => f.name).sort()).toEqual(['Code.gs', 'appsscript.json', 'index.html']);
    expect(Object.keys(gasSnapshot).sort()).toEqual(['Code.gs', 'appsscript.json']);
  });

  it('gas/ のソースは変更されない', () => {
    run({ iconUrl: FAKE_ID, redirectUrl: DEST });
    expect(snapshot(gasDir)).toEqual(gasSnapshot);
  });

  it('値が空なら置換しない', () => {
    const r = run();
    const code = fs.readFileSync(path.join(distDir, 'Code.gs'), 'utf8');
    expect(code).toBe(gasSnapshot['Code.gs']);
    expect(code).toContain("var APP_ICON_URL_ = '';");
    expect(code).toContain("var REDIRECT_URL_ = '';");
    expect(r.iconBaked || r.redirectBaked).toBe(false);
  });

  it('二回実行しても base は二重にならない', () => {
    run();
    run();
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    expect(html.match(/<base target="_top">/g)).toHaveLength(1);
  });

  it('環境変数から読み、引数が優先する', () => {
    run({ env: { AUDIO_SPLITTER_REDIRECT_URL: DEST, AUDIO_SPLITTER_ICON_URL: FAKE_ID } });
    let code = fs.readFileSync(path.join(distDir, 'Code.gs'), 'utf8');
    expect(code).toContain(DEST);
    expect(code).toContain(FAKE_ICON);
    const other = 'https://script.google.com/macros/s/OTHERID999/exec';
    run({ env: { AUDIO_SPLITTER_REDIRECT_URL: DEST }, redirectUrl: other });
    code = fs.readFileSync(path.join(distDir, 'Code.gs'), 'utf8');
    expect(code).toContain(other);
    expect(code).not.toContain(DEST);
  });

  it('値に $ が含まれても壊れない（置換パターンとして解釈されない）', () => {
    run({ iconUrl: 'https://example.test/a.png?x=$&y=$1$$' });
    const code = fs.readFileSync(path.join(distDir, 'Code.gs'), 'utf8');
    expect(code).toContain("var APP_ICON_URL_ = 'https://example.test/a.png?x=$&y=$1$$#.png';");
  });

  it('プレースホルダー行が無いとエラー（出力もしない）', () => {
    fs.writeFileSync(path.join(gasDir, 'Code.gs'), gasSnapshot['Code.gs'].replace("var APP_ICON_URL_ = '';", "var APP_ICON_URL_ = \"\";"), 'utf8');
    expect(() => run()).toThrow(/APP_ICON_URL_/);
    expect(fs.existsSync(path.join(distDir, 'Code.gs'))).toBe(false);
    fs.writeFileSync(path.join(gasDir, 'Code.gs'), gasSnapshot['Code.gs'].replace("var REDIRECT_URL_ = '';", ''), 'utf8');
    expect(() => run()).toThrow(/REDIRECT_URL_/);
  });

  it('不正な値・構文エラーはエラー', () => {
    expect(() => run({ redirectUrl: 'https://example.test/x' })).toThrow(/script\.google\.com/);
    expect(() => run({ iconUrl: 'http://example.test/a.png' })).toThrow(/https/);
    fs.writeFileSync(path.join(gasDir, 'Broken.gs'), 'function (', 'utf8');
    expect(() => run()).toThrow(SyntaxError);
  });

  it('index.html が無いとエラー', () => {
    fs.rmSync(path.join(distDir, 'index.html'));
    expect(() => run()).toThrow(/index\.html/);
  });

  it('前回の残骸（直下の .gs / .json / .html）だけ消し、他は触らない', () => {
    fs.writeFileSync(path.join(distDir, 'Old.gs'), '// old', 'utf8');
    fs.writeFileSync(path.join(distDir, 'old.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(distDir, 'Other.html'), '<p></p>', 'utf8');
    fs.writeFileSync(path.join(distDir, 'keep.txt'), 'x', 'utf8');
    fs.mkdirSync(path.join(distDir, 'sub'));
    fs.writeFileSync(path.join(distDir, 'sub', 'x.gs'), '// sub', 'utf8');
    run();
    expect(fs.readdirSync(distDir).sort()).toEqual(['Code.gs', 'appsscript.json', 'index.html', 'keep.txt', 'sub']);
    expect(fs.existsSync(path.join(distDir, 'sub', 'x.gs'))).toBe(true);
  });

  it('以前のビルドの Redirect.gs と Index.html が残っていても消え、Code.gs / index.html / appsscript.json だけになる', () => {
    // 大文字小文字を区別しない FS（Windows）では Index.html と index.html は同じファイルなので、いったん消してから古い綴りで作り直す
    fs.rmSync(path.join(distDir, 'index.html'));
    fs.writeFileSync(path.join(distDir, 'Index.html'), '<!doctype html><html><head></head><body>old</body></html>', 'utf8');
    fs.writeFileSync(path.join(distDir, 'Redirect.gs'), 'function redirectResponse_() {}', 'utf8');
    expect(fs.readdirSync(distDir)).toContain('Index.html');
    run();
    // readdirSync は実際に保存されている名前を返す。上書きでは Index.html が残ってしまうので、小文字の index.html であることまで確認する
    expect(fs.readdirSync(distDir).sort()).toEqual(['Code.gs', 'appsscript.json', 'index.html']);
    expect(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')).toContain('old');
    expect(fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')).toContain('<head><base target="_top">');
    // 関数の二重定義にならない（Code.gs 1 本に doGet とリダイレクト関数が 1 回ずつ）
    const code = fs.readFileSync(path.join(distDir, 'Code.gs'), 'utf8');
    expect(code.match(/function redirectResponse_\(/g)).toHaveLength(1);
    expect(code.match(/function doGet\(/g)).toHaveLength(1);
  });

  it('index.html に <? があれば警告だけ出して続行', () => {
    fs.writeFileSync(path.join(distDir, 'index.html'),'<html><head></head><body><script>var a="<?";</script></body></html>', 'utf8');
    const r = run();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/<\?/);
  });
});

describe('配信設定の組み立て（executeAs / access）', () => {
  let tmp, gasDir, distDir;
  const run = (o = {}) => bundleGas({ gasDir, distDir, env: {}, ...o });
  const dist = (n) => fs.readFileSync(path.join(distDir, n), 'utf8');
  const manifest = () => JSON.parse(dist('appsscript.json'));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gas-webapp-'));
    gasDir = path.join(tmp, 'gas');
    distDir = path.join(tmp, 'dist');
    fs.mkdirSync(gasDir);
    for (const n of fs.readdirSync(REAL_GAS_DIR)) fs.writeFileSync(path.join(gasDir, n), fs.readFileSync(path.join(REAL_GAS_DIR, n)));
    fs.mkdirSync(distDir);
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><head></head><body></body></html>', 'utf8');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('gas/ の既定: USER_DEPLOYING / MYSELF で、OAuth スコープも Advanced Service も指定しない', () => {
    const src = JSON.parse(fs.readFileSync(path.join(REAL_GAS_DIR, 'appsscript.json'), 'utf8'));
    expect(src.webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
    expect('oauthScopes' in src).toBe(false);
    expect('dependencies' in src).toBe(false);
  });

  it('既定: マニフェストは gas/ と同じ webapp 設定になる', () => {
    expect(run()).toMatchObject({ executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
    expect(manifest().webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
    expect(manifest()).toEqual(JSON.parse(fs.readFileSync(path.join(REAL_GAS_DIR, 'appsscript.json'), 'utf8')));
  });

  it('executeAs が deploying で anonymous の組み合わせは出力できる', () => {
    const r = run({ executeAs: 'deploying', access: 'anonymous' });
    expect(r).toMatchObject({ executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
    expect(manifest().webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  });

  it('executeAs: accessing を指定すると USER_ACCESSING になる', () => {
    expect(run({ executeAs: 'accessing' })).toMatchObject({ executeAs: 'USER_ACCESSING', access: 'MYSELF' });
    expect(manifest().webapp).toEqual({ executeAs: 'USER_ACCESSING', access: 'MYSELF' });
  });

  it('USER_ACCESSING と anonymous は両立しない: エラーで止まり、dist/ を書き換えない', () => {
    // gas/ の既定が USER_DEPLOYING なので、access だけ anonymous にするのは成り立つ。accessing を明示したときだけ止まる
    fs.writeFileSync(path.join(distDir, 'Code.gs'), '// previous', 'utf8');
    expect(() => run({ executeAs: 'accessing', access: 'anonymous' })).toThrow(/ログイン不要/);
    expect(() => run({ executeAs: 'accessing', access: 'anonymous' })).toThrow(/-ExecuteAs deploying/);
    expect(dist('Code.gs')).toBe('// previous');
    expect(fs.existsSync(path.join(distDir, 'appsscript.json'))).toBe(false);
    expect(() => planDeploy({ gasDir, env: {}, executeAs: 'accessing', access: 'anonymous' })).toThrow(/-ExecuteAs deploying/);
    // gas/ のマニフェストが USER_ACCESSING のときも、access: anonymous だけの指定で止まる
    const base = JSON.parse(fs.readFileSync(path.join(gasDir, 'appsscript.json'), 'utf8'));
    fs.writeFileSync(path.join(gasDir, 'appsscript.json'), JSON.stringify({ ...base, webapp: { executeAs: 'USER_ACCESSING', access: 'MYSELF' } }), 'utf8');
    expect(() => run({ access: 'anonymous' })).toThrow(/-ExecuteAs deploying/);
  });

  it('access: domain / anyone / myself', () => {
    expect(run({ access: 'domain' })).toMatchObject({ executeAs: 'USER_DEPLOYING', access: 'DOMAIN' });
    expect(manifest().webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'DOMAIN' });
    expect(run({ access: 'anyone', executeAs: 'accessing' })).toMatchObject({ access: 'ANYONE' });
    expect(run({ access: 'myself' }).access).toBe('MYSELF');
  });

  it('不正な executeAs / access は例外', () => {
    expect(() => run({ executeAs: 'everyone' })).toThrow(/executeAs/);
    expect(() => run({ access: 'public' })).toThrow(/access/);
  });

  it('buildManifest: 元を変えず webapp だけ書き換え、他の項目はそのまま残す', () => {
    const src = {
      runtimeVersion: 'V8',
      oauthScopes: ['https://www.googleapis.com/auth/spreadsheets'],
      dependencies: { libraries: [{ userSymbol: 'L' }] },
      webapp: { executeAs: 'USER_DEPLOYING', access: 'MYSELF' },
    };
    const copy = JSON.parse(JSON.stringify(src));
    const out = buildManifest(src, { executeAs: 'USER_ACCESSING', access: 'DOMAIN' });
    expect(src).toEqual(copy);
    expect(out).toEqual({ ...copy, webapp: { executeAs: 'USER_ACCESSING', access: 'DOMAIN' } });
    expect(buildManifest({ runtimeVersion: 'V8' }, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' }).webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
  });

  it('resolveWebapp', () => {
    const m = { webapp: { executeAs: 'USER_DEPLOYING', access: 'MYSELF' } };
    expect(resolveWebapp(m)).toEqual({ executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
    expect(resolveWebapp(m, { executeAs: 'accessing' })).toEqual({ executeAs: 'USER_ACCESSING', access: 'MYSELF' });
    expect(resolveWebapp(m, { executeAs: 'deploying', access: 'anonymous' })).toEqual({ executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
    expect(resolveWebapp(m, { executeAs: '', access: '' })).toEqual({ executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
  });
});

describe('CLI', () => {
  it('--dist / --gas を差し替えて実行できる（実 dist/ には触れない）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-gas-cli-'));
    try {
      const dist = path.join(tmp, 'dist');
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'index.html'),'<html><head></head><body></body></html>', 'utf8');
      const env = { ...process.env, AUDIO_SPLITTER_REDIRECT_URL: DEST };
      delete env.AUDIO_SPLITTER_ICON_URL;
      const r = spawnSync(process.execPath, [path.join(HERE, 'bundle-gas.mjs'), '--dist', dist, '--gas', REAL_GAS_DIR, '--icon-url', FAKE_ID], { env, encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('アイコン: 設定あり / リダイレクト: 設定あり');
      expect(r.stdout).not.toContain(FAKE_ID);
      expect(r.stdout).not.toContain(DEST);
      const bad = spawnSync(process.execPath, [path.join(HERE, 'bundle-gas.mjs'), '--dist', dist, '--redirect-url', 'nope'], { env, encoding: 'utf8' });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('[NG]');

      // --execute-as deploying --access anonymous は出力できる。--execute-as accessing --access anonymous は [NG]
      const anon = spawnSync(process.execPath, [path.join(HERE, 'bundle-gas.mjs'), '--dist', dist, '--gas', REAL_GAS_DIR, '--execute-as', 'deploying', '--access', 'anonymous'], { env, encoding: 'utf8' });
      expect(anon.status, anon.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(dist, 'appsscript.json'), 'utf8')).webapp).toEqual({ executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
      const before = fs.readFileSync(path.join(dist, 'appsscript.json'), 'utf8');
      const ng = spawnSync(process.execPath, [path.join(HERE, 'bundle-gas.mjs'), '--dist', dist, '--gas', REAL_GAS_DIR, '--execute-as', 'accessing', '--access', 'anonymous'], { env, encoding: 'utf8' });
      expect(ng.status).toBe(1);
      expect(ng.stderr).toContain('[NG]');
      expect(fs.readFileSync(path.join(dist, 'appsscript.json'), 'utf8')).toBe(before);

      // --plan: 何も書かず JSON を 1 行出す
      const planBefore = fs.readdirSync(dist).sort();
      const plan = spawnSync(process.execPath, [path.join(HERE, 'bundle-gas.mjs'), '--plan', '--gas', REAL_GAS_DIR, '--dist', dist, '--execute-as', 'deploying'], { env, encoding: 'utf8' });
      expect(plan.status, plan.stderr).toBe(0);
      expect(JSON.parse(plan.stdout.trim())).toEqual({ executeAs: 'USER_DEPLOYING', access: 'MYSELF' });
      expect(fs.readdirSync(dist).sort()).toEqual(planBefore);
      expect(fs.readFileSync(path.join(dist, 'appsscript.json'), 'utf8')).toBe(before);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
