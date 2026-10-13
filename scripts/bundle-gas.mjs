// dist/index.html（vite build の成果物）を、clasp が push できる形に仕上げる。
//
//   node scripts/bundle-gas.mjs [--icon-url <URL or ID>] [--redirect-url <URL>] [--dist <dir>] [--gas <dir>]
//                               [--drive off] [--execute-as <deploying|accessing>] [--access <myself|domain|anyone|anonymous>] [--plan]
//
// やること:
//   - gas/*.gs（現在は Code.gs 1 本）を dist/ にコピー（Code.gs のプレースホルダー行だけ置換。gas/ のソースは書き換えない）
//   - gas/appsscript.json を dist/ に出力（--execute-as / --access の指定を webapp に反映。deploy.ps1 は引数を渡すだけで、JSON の組み立てと判定はここだけ）
//   - Drive 連携の無効化（--drive off / AUDIO_SPLITTER_DRIVE=off。引数が優先）: Code.gs の DRIVE_ENABLED_ を false にし、
//     appsscript.json から Drive 連携用のスコープと Advanced Drive Service を取り除く。
//     最終的な executeAs が USER_ACCESSING 以外（USER_DEPLOYING）のときは、指定が無くても自動で無効にする
//     （デプロイした本人として実行すると、アクセスした全員がデプロイ者の Drive を操作できてしまうため）。
//   - 最終的な executeAs が USER_ACCESSING で access が ANYONE_ANONYMOUS（両立しない）ならエラー
//   - --plan: 何も書かず、配信設定の最終値を JSON 1 行で表示して終わる（deploy.ps1 の事前確認用）
//   - dist/index.html の <head> 直後に <base target="_top"> を挿入（二重には入れない）
//   - dist/ 直下の前回の残骸（.gs / .json / .html で今回の成果物でないもの）を、成果物を書く前に削除
//     （大文字小文字を区別しない Windows で、古い Index.html などが index.html の名前を引き継いで残らないようにするため、削除を先にする）
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
const DRIVE_ENABLED_RE = /^(var DRIVE_ENABLED_ = )true;(.*)$/m;
// Drive 連携に使うスコープ（gas/appsscript.json に明示しているもの）
export const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/userinfo.email',
];
// Drive 連携を無効にして組み立てるとき、oauthScopes から取り除くスコープ（Drive の読み書きと外部通信）
export const DRIVE_ACCESS_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.external_request',
];
// 無効のときも必ず明示しておくスコープ。oauthScopes を空（未指定）にすると、Apps Script がコードの内容から
// 必要なスコープを自動で判定し、dist/Code.gs に残っている Drive 関連のコードを見て drive を付け直してしまう。
// 明示のスコープがあれば自動判定は行われないので、害のないスコープ（自分のメールアドレスの参照）だけを残す。
export const DISABLED_BASE_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
const EXECUTE_AS_MAP = { deploying: 'USER_DEPLOYING', accessing: 'USER_ACCESSING' };
const ACCESS_MAP = { myself: 'MYSELF', domain: 'DOMAIN', anyone: 'ANYONE', anonymous: 'ANYONE_ANONYMOUS' };
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
 * https://script.google.com/ で始まり、デプロイ ID（/s/<ID>）を取り出せる形だけ受け付ける（gas/Code.gs の redirectDeployId_ と同じ判定）。
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

/**
 * Drive 連携を有効にするかの指定（--drive / AUDIO_SPLITTER_DRIVE）を真偽にする。'off'（大文字小文字・前後の空白は無視）だけが無効。
 * 空・未指定・'on' は有効。それ以外の値は例外（打ち間違いで意図せず有効のまま組み立てないため）。
 */
export function normalizeDrive(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s === '' || s === 'on') return true;
  if (s === 'off') return false;
  throw new Error(`Drive 連携の指定は on か off にしてください（指定値: ${s.slice(0, 20)}）。`);
}

/** Code.gs のプレースホルダー行を置換する。行が無ければ例外。値が空なら置換しない。driveEnabled === false のとき DRIVE_ENABLED_ を false にする。 */
export function bakeCodeGs(source, { iconUrl = '', redirectUrl = '', driveEnabled = true } = {}) {
  if (!ICON_URL_RE.test(source)) throw new Error("Code.gs に \"var APP_ICON_URL_ = '';\" の行が見つかりません。");
  if (!REDIRECT_URL_RE.test(source)) throw new Error("Code.gs に \"var REDIRECT_URL_ = '';\" の行が見つかりません。");
  if (!DRIVE_ENABLED_RE.test(source)) throw new Error('Code.gs に "var DRIVE_ENABLED_ = true;" の行が見つかりません。');
  let out = source;
  // 関数形式の replace（値に $ などが含まれても置換パターンとして解釈されない）
  if (iconUrl) out = out.replace(ICON_URL_RE, (_, a, b) => a + "'" + iconUrl + "';" + b);
  if (redirectUrl) out = out.replace(REDIRECT_URL_RE, (_, a, b) => a + "'" + redirectUrl + "';" + b);
  if (driveEnabled === false) out = out.replace(DRIVE_ENABLED_RE, (_, a, b) => a + 'false;' + b);
  return out;
}

/**
 * 配信設定（executeAs / access / Drive 連携）の最終値を決める。deploy.ps1 は引数をここへ渡すだけで、判定は持たない。
 * @param {object} manifest gas/appsscript.json を JSON.parse したもの（webapp の既定値）
 * @param {object} [o]
 * @param {string} [o.executeAs] 'deploying' | 'accessing'（省略 = マニフェストの値）
 * @param {string} [o.access] 'myself' | 'domain' | 'anyone' | 'anonymous'（省略 = マニフェストの値）
 * @param {string|boolean} [o.drive] 'off' で Drive 連携を無効にする（既定は有効）
 * @returns {{executeAs: string, access: string, driveEnabled: boolean, driveAutoDisabled: boolean}}
 *   driveAutoDisabled = Drive 連携を有効にするつもりだったが、executeAs が USER_ACCESSING でないため自動で無効にした
 * 規則:
 *   - Drive 連携が有効になるのは executeAs が USER_ACCESSING のときだけ。それ以外（USER_DEPLOYING、未指定を含む）は自動で無効にする
 *     （デプロイした本人として実行すると、アクセスした全員がデプロイ者の Drive を操作できてしまうため）。
 *   - USER_ACCESSING と ANYONE_ANONYMOUS は両立しない（ログインしていない人には「アクセスしているユーザー」がいない）ので例外。
 */
export function resolveWebapp(manifest, o = {}) {
  const base = (manifest && manifest.webapp) || {};
  let executeAs = base.executeAs;
  if (o.executeAs !== undefined && o.executeAs !== '') {
    if (!Object.prototype.hasOwnProperty.call(EXECUTE_AS_MAP, o.executeAs)) throw new Error(`executeAs は deploying か accessing にしてください（指定値: ${String(o.executeAs).slice(0, 20)}）。`);
    executeAs = EXECUTE_AS_MAP[o.executeAs];
  }
  let access = base.access;
  if (o.access !== undefined && o.access !== '') {
    if (!Object.prototype.hasOwnProperty.call(ACCESS_MAP, o.access)) throw new Error(`access は myself / domain / anyone / anonymous のどれかにしてください（指定値: ${String(o.access).slice(0, 20)}）。`);
    access = ACCESS_MAP[o.access];
  }
  if (executeAs === 'USER_ACCESSING' && access === 'ANYONE_ANONYMOUS') {
    throw new Error('ログイン不要（-Access anonymous）の公開は「アクセスしているユーザーとして実行」と両立しません（ログインしていない人には「アクセスしているユーザー」がいないため、Google がこの組み合わせを受け付けません）。' +
      'ログイン不要で公開するなら -ExecuteAs deploying を付けてください（その場合 Google ドライブ連携は無効になります）。');
  }
  const requested = typeof o.drive === 'boolean' ? o.drive : normalizeDrive(o.drive);
  const driveEnabled = requested && executeAs === 'USER_ACCESSING';
  return { executeAs, access, driveEnabled, driveAutoDisabled: requested && !driveEnabled };
}

/**
 * マニフェストを組み立てる（元のオブジェクトは変えない）。resolveWebapp の結果を webapp に書き、Drive 連携が無効なら権限を外す。
 * 無効のとき: oauthScopes から DRIVE_ACCESS_SCOPES を取り除き、DISABLED_BASE_SCOPE を必ず含む明示の一覧にする
 * （oauthScopes を未指定にしない。未指定だと Apps Script がコードからスコープを自動判定し、drive が付き直すため）。
 * dependencies.enabledAdvancedServices からは Drive を取り除く（空になった項目はキーごと消す）。
 */
export function buildManifest(manifest, resolved) {
  const m = JSON.parse(JSON.stringify(manifest));
  m.webapp = { ...(m.webapp || {}), executeAs: resolved.executeAs, access: resolved.access };
  if (!resolved.driveEnabled) {
    const kept = (Array.isArray(m.oauthScopes) ? m.oauthScopes : []).filter((s) => !DRIVE_ACCESS_SCOPES.includes(s));
    if (!kept.includes(DISABLED_BASE_SCOPE)) kept.push(DISABLED_BASE_SCOPE);
    m.oauthScopes = kept;
    if (m.dependencies && Array.isArray(m.dependencies.enabledAdvancedServices)) {
      m.dependencies.enabledAdvancedServices = m.dependencies.enabledAdvancedServices.filter((s) => !(s && (s.serviceId === 'drive' || s.userSymbol === 'Drive')));
      if (m.dependencies.enabledAdvancedServices.length === 0) delete m.dependencies.enabledAdvancedServices;
      if (Object.keys(m.dependencies).length === 0) delete m.dependencies;
    }
  }
  return m;
}

/** <head> 開始タグの直後に <base target="_top"> を入れる。既にあれば何もしない。 */
export function insertBaseTag(html) {
  if (BASE_TAG_RE.test(html)) return html;
  const m = HEAD_OPEN_RE.exec(html);
  if (!m) throw new Error('index.html に <head> 開始タグが見つかりません。');
  const at = m.index + m[0].length;
  return html.slice(0, at) + BASE_TAG + html.slice(at);
}

/**
 * dist/ を組み立てる。
 * @param {object} [opts]
 * @param {string} [opts.gasDir] gas/ のソースのディレクトリ
 * @param {string} [opts.distDir] vite の出力先（index.html が既にあること）
 * @param {string} [opts.iconUrl] 未指定なら環境変数 AUDIO_SPLITTER_ICON_URL
 * @param {string} [opts.redirectUrl] 未指定なら環境変数 AUDIO_SPLITTER_REDIRECT_URL
 * @param {string} [opts.executeAs] 'deploying' | 'accessing'（省略 = gas/appsscript.json の値）
 * @param {string} [opts.access] 'myself' | 'domain' | 'anyone' | 'anonymous'（省略 = gas/appsscript.json の値）
 * @param {string} [opts.drive] 'off' で Drive 連携を無効にして組み立てる。未指定なら環境変数 AUDIO_SPLITTER_DRIVE（既定は有効）
 * @param {object} [opts.env] 環境変数（テスト用。既定は process.env）
 * @returns {{files: {name: string, bytes: number}[], iconBaked: boolean, redirectBaked: boolean, executeAs: string, access: string, driveEnabled: boolean, driveAutoDisabled: boolean, warnings: string[]}}
 */
export function bundleGas(opts = {}) {
  const gasDir = opts.gasDir ?? DEFAULT_GAS_DIR;
  const distDir = opts.distDir ?? DEFAULT_DIST_DIR;
  const env = opts.env ?? process.env;
  const iconUrl = normalizeIconUrl(opts.iconUrl !== undefined ? opts.iconUrl : env.AUDIO_SPLITTER_ICON_URL);
  const redirectUrl = normalizeRedirectUrl(opts.redirectUrl !== undefined ? opts.redirectUrl : env.AUDIO_SPLITTER_REDIRECT_URL);
  const warnings = [];

  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error(`${indexPath} がありません。先に npm run build を実行してください。`);
  if (!fs.existsSync(gasDir)) throw new Error(`${gasDir} がありません。`);

  const gsNames = fs.readdirSync(gasDir).filter((n) => n.endsWith('.gs')).sort();
  if (!gsNames.includes('Code.gs')) throw new Error('gas/Code.gs がありません。');
  const manifestPath = path.join(gasDir, 'appsscript.json');
  if (!fs.existsSync(manifestPath)) throw new Error('gas/appsscript.json がありません。');

  // 配信設定の最終値（executeAs / access / Drive 連携）。不整合ならここで例外（何も書かない）
  const resolved = resolveWebapp(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    executeAs: opts.executeAs,
    access: opts.access,
    drive: opts.drive !== undefined ? opts.drive : env.AUDIO_SPLITTER_DRIVE,
  });

  // 先にすべてメモリ上で作って検証する（途中で失敗して dist/ が中途半端にならないように）
  const outputs = new Map();
  for (const name of gsNames) {
    let code = fs.readFileSync(path.join(gasDir, name), 'utf8');
    if (name === 'Code.gs') code = bakeCodeGs(code, { iconUrl, redirectUrl, driveEnabled: resolved.driveEnabled });
    new vm.Script(code, { filename: name }); // 構文チェック（失敗時は SyntaxError）
    outputs.set(name, code);
  }
  outputs.set('appsscript.json', JSON.stringify(buildManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), resolved), null, 2) + '\n');
  const html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes('<?')) {
    warnings.push('index.html に "<?" が含まれています。createHtmlOutputFromFile はテンプレート評価をしないので通常は問題ありませんが、createTemplateFromFile に変えると壊れます。');
  }
  outputs.set('index.html', insertBaseTag(html));

  // 前回の残骸（dist/ 直下の .gs / .json / .html で今回の成果物でないもの）を削除。サブディレクトリや他の種別には触れない。
  // 名前は大文字小文字まで厳密に比較する。Windows では古い Index.html に index.html を上書きすると名前が Index.html のまま残るので、
  // 「綴りが違うものは先に消し、そのあと書く」順にして、ファイル名が必ず小文字の index.html になるようにする。
  // （index.html の内容は上で読み込み済みなので、先に消しても失われない）
  for (const ent of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!ent.isFile() || outputs.has(ent.name)) continue;
    if (MANAGED_EXTS.has(path.extname(ent.name).toLowerCase())) fs.rmSync(path.join(distDir, ent.name));
  }

  for (const [name, content] of outputs) fs.writeFileSync(path.join(distDir, name), content, 'utf8');

  const files = [...outputs.keys()].map((name) => ({ name, bytes: fs.statSync(path.join(distDir, name)).size }));
  return { files, iconBaked: iconUrl !== '', redirectBaked: redirectUrl !== '', ...resolved, warnings };
}

/**
 * 何も書かずに、配信設定の最終値（executeAs / access / Drive 連携）だけを決めて返す（deploy.ps1 の事前確認・-WhatIf 用）。
 * 不整合（USER_ACCESSING と ANYONE_ANONYMOUS）は例外。opts は bundleGas と同じ（executeAs / access / drive / gasDir / env）。
 */
export function planDeploy(opts = {}) {
  const gasDir = opts.gasDir ?? DEFAULT_GAS_DIR;
  const env = opts.env ?? process.env;
  const manifestPath = path.join(gasDir, 'appsscript.json');
  if (!fs.existsSync(manifestPath)) throw new Error('gas/appsscript.json がありません。');
  return resolveWebapp(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
    executeAs: opts.executeAs,
    access: opts.access,
    drive: opts.drive !== undefined ? opts.drive : env.AUDIO_SPLITTER_DRIVE,
  });
}

export function parseArgs(argv) {
  const opts = {};
  const keys = {
    '--icon-url': 'iconUrl', '--redirect-url': 'redirectUrl', '--dist': 'distDir', '--gas': 'gasDir',
    '--drive': 'drive', '--execute-as': 'executeAs', '--access': 'access',
  };
  const flags = { '--plan': 'plan' };
  for (let i = 0; i < argv.length; i++) {
    if (Object.prototype.hasOwnProperty.call(flags, argv[i])) { opts[flags[argv[i]]] = true; continue; }
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
  const { plan, ...opts } = parseArgs(process.argv.slice(2));
  if (plan) {
    // 何も書かない。deploy.ps1 が JSON として読む（1 行）
    console.log(JSON.stringify(planDeploy(opts)));
    return;
  }
  const r = bundleGas(opts);
  const distDir = opts.distDir ?? DEFAULT_DIST_DIR;
  console.log(`[bundle-gas] ${distDir}`);
  for (const f of r.files) console.log(`  ${f.name.padEnd(16)} ${(f.bytes / 1024).toFixed(1).padStart(9)} KB`);
  console.log(`  アイコン: ${r.iconBaked ? '設定あり' : 'なし'} / リダイレクト: ${r.redirectBaked ? '設定あり' : 'なし'}`);
  console.log(`  executeAs: ${r.executeAs} / access: ${r.access} / Google ドライブ連携: ${r.driveEnabled ? '有効' : (r.driveAutoDisabled ? '無効（executeAs が USER_ACCESSING でないため自動で無効）' : '無効')}`);
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
