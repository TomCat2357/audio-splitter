// dist/Index.html（vite build の成果物）を、clasp が push できる形に仕上げる。
//
//   node scripts/bundle-gas.mjs [--icon-url <URL or ID>] [--redirect-url <URL>] [--dist <dir>] [--gas <dir>]
//
// やること:
//   - gas/*.gs を dist/ にコピー（Code.gs のプレースホルダー行だけ置換。gas/ のソースは書き換えない）
//   - gas/appsscript.json を dist/ にコピー
//   - dist/Index.html の <head> 直後に <base target="_top"> を挿入（二重には入れない）
//   - dist/ 直下の前回の残骸（.gs / .json / .html で今回の成果物でないもの）を削除
//   - 出力した .gs を構文チェック
// 値の入力元: CLI 引数（--icon-url / --redirect-url）> 環境変数（AUDIO_SPLITTER_ICON_URL / AUDIO_SPLITTER_REDIRECT_URL）。
// 依存パッケージなし（Node 標準のみ）。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_GAS_DIR = path.join(ROOT, 'gas');
export const DEFAULT_DIST_DIR = path.join(ROOT, 'dist');

const ICON_URL_RE = /^(var APP_ICON_URL_ = )'';(.*)$/m;
const REDIRECT_URL_RE = /^(var REDIRECT_URL_ = )'';(.*)$/m;
const BASE_TAG = '<base target="_top">';
const BASE_TAG_RE = /<base\b[^>]*\btarget\s*=\s*["']?_top["']?[^>]*>/i;
const HEAD_OPEN_RE = /<head(?:\s[^>]*)?>/i;
const MANAGED_EXTS = new Set(['.gs', '.json', '.html']);

/**
 * タブのアイコン（favicon）の URL を決める。空は ''（既定のアイコンのまま）。不正は例外。
 * 受け付ける形: Drive の共有 URL（/file/d/<ID>/ または ?id=<ID>）、Drive のファイル ID（英数字・_・- の 20 文字以上）→ lh3.googleusercontent.com/d/<ID> に変換。
 * それ以外は https:// の画像 URL。GAS の setFaviconUrl は URL 末尾の拡張子（png / ico / jpg / gif）を検査して拒否するため、
 * 変換先と、末尾が拡張子でなく '#' も含まない URL には末尾に '#.png' を足す（# 以降はサーバーに送られないので取得結果は変わらない）。
 * 末尾に '#.ico' / '#.png' / '#.jpg' / '#.jpeg' / '#.gif' を書けば、その拡張子を尊重する。
 */
export function normalizeIconUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const extM = /#(\.(?:png|ico|jpe?g|gif))$/i.exec(s);
  const ext = extM ? extM[1].toLowerCase() : '.png';
  const body = extM ? s.slice(0, s.length - extM[0].length) : s;
  const drive = (id) => 'https://lh3.googleusercontent.com/d/' + id + '#' + ext;
  if (/^[A-Za-z0-9_-]{20,200}$/.test(body)) return drive(body);
  if (!/^https:\/\//i.test(s)) throw new Error('アイコンの URL は https:// で始まる URL か、Drive のファイル ID を指定してください。');
  // JS 文字列リテラル・HTML 属性に入れても壊れない文字だけ許可（空白・引用符・バックスラッシュ・<> などは不可）
  if (!/^[\x21\x23-\x26\x28-\x3b\x3d\x3f-\x5b\x5d-\x7e]+$/.test(s) || s.length > 2000) throw new Error('アイコンの URL に使えない文字が含まれています。');
  let u;
  try { u = new URL(body); } catch { throw new Error('アイコンの URL を解釈できません。'); }
  if (u.protocol !== 'https:' || !u.hostname) throw new Error('アイコンの URL は https:// で始まる必要があります。');
  if (u.hostname === 'drive.google.com' || u.hostname === 'docs.google.com') {
    const m = /\/file\/d\/([A-Za-z0-9_-]{20,200})(?:[/?#]|$)/.exec(u.pathname) || /^([A-Za-z0-9_-]{20,200})$/.exec(u.searchParams.get('id') || '');
    if (!m) throw new Error('Drive の URL からファイル ID を取り出せません（https://drive.google.com/file/d/<ID>/view の形式で指定してください）。');
    return drive(m[1]);
  }
  if (extM) return body + '#' + ext;
  if (/\.(png|ico|jpe?g|gif)$/i.test(s)) return s;
  if (s.includes('#')) throw new Error('アイコンの URL の # 以降は #.png / #.ico / #.jpg / #.jpeg / #.gif のいずれかにしてください。');
  return s + '#.png';
}

/**
 * リダイレクト先（新しいデプロイの URL）を決める。空は ''（焼き込まない）。不正は例外。
 * https://script.google.com/ で始まり、デプロイ ID（/s/<ID>）を取り出せる形だけ受け付ける（gas/Redirect.gs の redirectDeployId_ と同じ判定）。
 * 値は Code.gs にシングルクォートの文字列リテラルとして埋め込まれるため、引用符・空白・バックスラッシュ・山括弧などを含む値は不可。
 */
export function normalizeRedirectUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (!s.startsWith('https://script.google.com/')) throw new Error('リダイレクト先は https://script.google.com/ で始まる Web アプリの URL を指定してください。');
  if (!/^[\x21\x23-\x26\x28-\x3b\x3d\x3f-\x5b\x5d-\x7e]+$/.test(s) || s.length > 2000) {
    throw new Error('リダイレクト先の URL に使えない文字が含まれています（空白・引用符・バックスラッシュ・山括弧などは不可）。');
  }
  if (!/^https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#]+\/|a\/[^/?#]+\/macros\/|macros\/)s\/[A-Za-z0-9_-]+(?:[/?#]|$)/.test(s)) {
    throw new Error('リダイレクト先の URL からデプロイ ID を取り出せません（https://script.google.com/macros/s/<デプロイID>/exec の形式で指定してください）。');
  }
  return s;
}

/** Code.gs のプレースホルダー行を置換する。行が無ければ例外。値が空なら置換しない。 */
export function bakeCodeGs(source, { iconUrl = '', redirectUrl = '' } = {}) {
  if (!ICON_URL_RE.test(source)) throw new Error("Code.gs に \"var APP_ICON_URL_ = '';\" の行が見つかりません。");
  if (!REDIRECT_URL_RE.test(source)) throw new Error("Code.gs に \"var REDIRECT_URL_ = '';\" の行が見つかりません。");
  let out = source;
  // 関数形式の replace（値に $ などが含まれても置換パターンとして解釈されない）
  if (iconUrl) out = out.replace(ICON_URL_RE, (_, a, b) => a + "'" + iconUrl + "';" + b);
  if (redirectUrl) out = out.replace(REDIRECT_URL_RE, (_, a, b) => a + "'" + redirectUrl + "';" + b);
  return out;
}

/** <head> 開始タグの直後に <base target="_top"> を入れる。既にあれば何もしない。 */
export function insertBaseTag(html) {
  if (BASE_TAG_RE.test(html)) return html;
  const m = HEAD_OPEN_RE.exec(html);
  if (!m) throw new Error('Index.html に <head> 開始タグが見つかりません。');
  const at = m.index + m[0].length;
  return html.slice(0, at) + BASE_TAG + html.slice(at);
}

/**
 * dist/ を組み立てる。
 * @param {object} [opts]
 * @param {string} [opts.gasDir] gas/ のソースのディレクトリ
 * @param {string} [opts.distDir] vite の出力先（Index.html が既にあること）
 * @param {string} [opts.iconUrl] 未指定なら環境変数 AUDIO_SPLITTER_ICON_URL
 * @param {string} [opts.redirectUrl] 未指定なら環境変数 AUDIO_SPLITTER_REDIRECT_URL
 * @param {object} [opts.env] 環境変数（テスト用。既定は process.env）
 * @returns {{files: {name: string, bytes: number}[], iconBaked: boolean, redirectBaked: boolean, warnings: string[]}}
 */
export function bundleGas(opts = {}) {
  const gasDir = opts.gasDir ?? DEFAULT_GAS_DIR;
  const distDir = opts.distDir ?? DEFAULT_DIST_DIR;
  const env = opts.env ?? process.env;
  const iconUrl = normalizeIconUrl(opts.iconUrl !== undefined ? opts.iconUrl : env.AUDIO_SPLITTER_ICON_URL);
  const redirectUrl = normalizeRedirectUrl(opts.redirectUrl !== undefined ? opts.redirectUrl : env.AUDIO_SPLITTER_REDIRECT_URL);
  const warnings = [];

  const indexPath = path.join(distDir, 'Index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`${indexPath} がありません。先に npm run build を実行してください。`);
  if (!fs.existsSync(gasDir)) throw new Error(`${gasDir} がありません。`);

  const gsNames = fs.readdirSync(gasDir).filter((n) => n.endsWith('.gs')).sort();
  if (!gsNames.includes('Code.gs')) throw new Error('gas/Code.gs がありません。');
  const manifestPath = path.join(gasDir, 'appsscript.json');
  if (!fs.existsSync(manifestPath)) throw new Error('gas/appsscript.json がありません。');

  // 先にすべてメモリ上で作って検証する（途中で失敗して dist/ が中途半端にならないように）
  const outputs = new Map();
  for (const name of gsNames) {
    let code = fs.readFileSync(path.join(gasDir, name), 'utf8');
    if (name === 'Code.gs') code = bakeCodeGs(code, { iconUrl, redirectUrl });
    new vm.Script(code, { filename: name }); // 構文チェック（失敗時は SyntaxError）
    outputs.set(name, code);
  }
  outputs.set('appsscript.json', fs.readFileSync(manifestPath, 'utf8'));
  const html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes('<?')) {
    warnings.push('Index.html に "<?" が含まれています。createHtmlOutputFromFile はテンプレート評価をしないので通常は問題ありませんが、createTemplateFromFile に変えると壊れます。');
  }
  outputs.set('Index.html', insertBaseTag(html));

  for (const [name, content] of outputs) fs.writeFileSync(path.join(distDir, name), content, 'utf8');

  // 前回の残骸（dist/ 直下の .gs / .json / .html で今回の成果物でないもの）を削除。サブディレクトリや他の種別には触れない
  for (const ent of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!ent.isFile() || outputs.has(ent.name)) continue;
    if (MANAGED_EXTS.has(path.extname(ent.name).toLowerCase())) fs.rmSync(path.join(distDir, ent.name));
  }

  const files = [...outputs.keys()].map((name) => ({ name, bytes: fs.statSync(path.join(distDir, name)).size }));
  return { files, iconBaked: iconUrl !== '', redirectBaked: redirectUrl !== '', warnings };
}

export function parseArgs(argv) {
  const opts = {};
  const keys = { '--icon-url': 'iconUrl', '--redirect-url': 'redirectUrl', '--dist': 'distDir', '--gas': 'gasDir' };
  for (let i = 0; i < argv.length; i++) {
    let [k, v] = argv[i].split(/=(.*)/s, 2);
    if (!(k in keys)) throw new Error(`不明な引数です: ${argv[i]}`);
    if (v === undefined) {
      v = argv[++i];
      if (v === undefined) throw new Error(`${k} に値がありません。`);
    }
    opts[keys[k]] = v;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = bundleGas(opts);
  const distDir = opts.distDir ?? DEFAULT_DIST_DIR;
  console.log(`[bundle-gas] ${distDir}`);
  for (const f of r.files) console.log(`  ${f.name.padEnd(16)} ${(f.bytes / 1024).toFixed(1).padStart(9)} KB`);
  console.log(`  アイコン: ${r.iconBaked ? '設定あり' : 'なし'} / リダイレクト: ${r.redirectBaked ? '設定あり' : 'なし'}`);
  for (const w of r.warnings) console.warn(`[警告] ${w}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(`[NG] ${e.message}`);
    process.exit(1);
  }
}
