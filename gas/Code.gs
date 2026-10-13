// 音声処理はすべてブラウザ側で行う。GAS は HTML を返す（doGet）ほか、Google ドライブの閲覧・読み込み・保存の窓口になる。
// このファイル 1 本に、HTML を返す doGet、旧デプロイ → 新デプロイへのリダイレクト（「リダイレクト」節）、
// Google ドライブ連携（「Google ドライブ連携」節）が入っている。
//
// 次の 3 行は scripts/bundle-gas.mjs が dist/Code.gs でのみ差し替える（deploy.ps1 の -IconUrl / -RedirectUrl / Drive 連携の無効化）。
// このソース（gas/Code.gs）自体は書き換わらない。行の形を変えるとビルドが止まるので、そのまま残すこと。
// Google ドライブ連携の有効 / 無効。false にすると、Drive 関連の公開関数はすべて DRIVE_DISABLED を返し、Drive には一切アクセスしない。
// 「デプロイしたユーザーとして実行」の構成では deploy.ps1 が自動で false にして組み立てる（詳細は「Google ドライブ連携」節の冒頭）。
var DRIVE_ENABLED_ = true;
// タブのアイコン（favicon）の URL。https のみ。空なら Apps Script 既定のアイコンのまま。
// GAS は URL 末尾の拡張子（png / ico / jpg / gif）を検査するため、bundle-gas.mjs が末尾に '#.png' などを足す。
// スクリプト プロパティ AUDIO_SPLITTER_ICON_URL が設定されていればそちらが優先される（下の「タブのアイコン」節を参照）。
var APP_ICON_URL_ = '';
// 旧デプロイから開かれたときの移動先（新しいデプロイの URL）。空なら移動しない。
// スクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL が設定されていればそちらが優先される（下の「リダイレクト」節を参照）。
var REDIRECT_URL_ = '';

function doGet(e) {
  // 旧デプロイ → 新デプロイへのリダイレクト。移動するなら案内ページの HtmlOutput、しなければ null
  var moved = redirectResponse_(e);
  if (moved) return moved;

  // 注意: createHtmlOutput(文字列) で HTML を作り直さないこと。
  // 約 2MB のインラインスクリプトを GAS のパーサが誤認して壊すため、必ず createHtmlOutputFromFile を使う。
  // （createHtmlOutputFromFile はテンプレート評価をしないので、HTML 内の「<?」も評価されない）
  var output = HtmlService.createHtmlOutputFromFile('index')
    .setTitle('音声分割')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);

  // アイコンの URL は、スクリプト プロパティ（優先）か、デプロイ時の焼き込み値で決める。決まったときだけ設定する（失敗しても画面は出す）
  var iconProp = null;
  try { iconProp = PropertiesService.getScriptProperties().getProperty(ICON_PROP_KEY_); } catch (err) { iconProp = null; }
  var iconUrl = iconDestination_(iconProp, APP_ICON_URL_);
  if (iconPropInvalid_(iconProp)) {
    // 値そのものはログに出さない
    console.error('スクリプト プロパティ ' + ICON_PROP_KEY_ + ' の値が不正なため、アイコンを付けません');
  }
  if (iconUrl) {
    try {
      output = output.setFaviconUrl(iconUrl);
    } catch (err2) {
      console.error('setFaviconUrl に失敗: ' + err2);
    }
  }
  return output;
}

// ============================================================================
// リダイレクト（旧デプロイ → 新デプロイ）
//
// 移動先の決め方（redirectDestination_）:
//   1. スクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL が設定されていれば、それを使う（再デプロイなしで切り替え・解除できる）。
//      値が off（大文字小文字・前後の空白は無視）なら、焼き込み値があっても移動しない（解除）。
//      値が URL として不正なとき（https://script.google.com/ で始まらない、デプロイ ID を取り出せない）は、移動しない。
//      焼き込み値には戻さない（誤設定に気づけるようにするため）。
//   2. プロパティが未設定・空なら、焼き込み値 REDIRECT_URL_（上の変数。deploy.ps1 -RedirectUrl）を使う。
//   3. どちらも空なら何もしない。
//
// ループ防止と移動先の変更への追従は、移動先 URL に付ける redirect_target=<移動先のデプロイID> で行う。
// クエリの redirect_target が今の移動先 ID と一致すれば「移動済み」として通常表示し、一致しなければ（古い ID など）今の移動先へ移す。
// 新しいデプロイを素の URL で開くと、自分自身へ 1 回だけ移動してから表示される（許容）。
// ScriptApp.getService().getUrl() は、開かれたデプロイによらず /dev の URL を返す（実機確認済み）ので「どのデプロイが開かれたか」の判別には使えず、
// 呼ばない（現在の URL は不明として扱う。OAuth スコープも増やさない）。/dev で試すときは ?noredirect=1 を付ける
// （noredirect=1 は管理者・/dev 確認用の手動オーバーライドで、移動先 URL には付けない）。
//
// 次の場合は何もしない（通常どおり表示）:
//   移動先が未設定・空・off・不正 / クエリ ?noredirect=1 / クエリ redirect_target（前後の空白を除く）が今の移動先 ID と同じ
// 起動 URL のクエリ（e.parameters の全部。noredirect・redirect_target を除く）は移動先にそのまま付け、最後に redirect_target=<移動先 ID> を 1 つだけ付ける。
// ============================================================================

var REDIRECT_PROP_KEY_ = 'AUDIO_SPLITTER_REDIRECT_URL';
var REDIRECT_PREFIX_ = 'https://script.google.com/';
var REDIRECT_OFF_ = 'off';

/** デプロイ URL から /s/<デプロイID>/ の ID を取り出す。https://script.google.com/ 以外・取り出せなければ null。 */
function redirectDeployId_(url) {
  var s = String(url == null ? '' : url).replace(/^\s+|\s+$/g, '');
  if (s.indexOf(REDIRECT_PREFIX_) !== 0) return null;
  var m = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/?#]+\/|a\/[^\/?#]+\/macros\/|macros\/)s\/([A-Za-z0-9_-]+)(?:[\/?#]|$)/.exec(s);
  return m ? m[1] : null;
}

/**
 * 移動先 URL を決める（優先順位は上の「リダイレクト」節のコメント）。移動しないときは ''。
 * @param {*} propValue スクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL の値
 * @param {*} bakedValue 焼き込み値 REDIRECT_URL_
 */
function redirectDestination_(propValue, bakedValue) {
  var prop = String(propValue == null ? '' : propValue).replace(/^\s+|\s+$/g, '');
  if (prop) {
    if (prop.toLowerCase() === REDIRECT_OFF_) return '';
    return prop;
  }
  return String(bakedValue == null ? '' : bakedValue).replace(/^\s+|\s+$/g, '');
}

/** doGet の e → クエリ文字列（先頭の ? なし）。e.parameters（複数値）を優先し、無ければ e.parameter。noredirect・redirect_target は含めない。 */
function redirectQuery_(e) {
  var src = (e && e.parameters && typeof e.parameters === 'object') ? e.parameters : ((e && e.parameter && typeof e.parameter === 'object') ? e.parameter : {});
  var parts = [];
  Object.keys(src).forEach(function (k) {
    if (k === 'noredirect' || k === 'redirect_target') return;
    var v = src[k];
    var arr = Object.prototype.toString.call(v) === '[object Array]' ? v : [v];
    arr.forEach(function (x) { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(x == null ? '' : String(x))); });
  });
  return parts.join('&');
}

/**
 * リダイレクト先 URL（クエリ付き）。リダイレクトしないときは null。
 * @param {Object} e doGet のイベント
 * @param {*} destination 移動先 URL（redirectDestination_ の結果）
 */
function redirectTarget_(e, destination) {
  var dest = String(destination == null ? '' : destination).replace(/^\s+|\s+$/g, '');
  if (!dest) return null;
  var toId = redirectDeployId_(dest);
  if (!toId) return null;
  var p = e && e.parameter;
  if (p && String(p.noredirect == null ? '' : p.noredirect).replace(/^\s+|\s+$/g, '') === '1') return null;
  // 移動済み（クエリの redirect_target が今の移動先 ID と同じ）なら飛ばさない。違えば（古い ID など）今の移動先へ移す
  if (p && String(p.redirect_target == null ? '' : p.redirect_target).replace(/^\s+|\s+$/g, '') === toId) return null;
  var base = dest.replace(/[?#].*$/, '');
  var q = redirectQuery_(e);
  return base + '?' + (q ? q + '&' : '') + 'redirect_target=' + encodeURIComponent(toId);
}

function redirectEscapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JS の文字列リテラル（引用符込み）。</script> や行区切り文字で壊れないようにする。 */
function redirectJsString_(s) {
  return JSON.stringify(String(s)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** 案内ページの HTML（自動で top を移動先へ。動かなければ文言とボタン）。 */
function redirectPageHtml_(target) {
  var href = redirectEscapeHtml_(target);
  return '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>音声分割</title><style>body{font-family:sans-serif;background:#f1f5f9;color:#334155;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}' +
    '.box{background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.15);padding:28px 32px;max-width:480px;text-align:center}' +
    'a.btn{display:inline-block;margin-top:16px;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold}</style></head>' +
    '<body><div class="box" data-testid="redirect-page"><h1 style="font-size:18px;margin:0 0 8px">音声分割 - 移動しています…</h1>' +
    '<p style="font-size:14px;margin:0">自動で移動しない場合は下のボタンを押してください。ブックマークは移動後のアドレスに更新してください（今後の移動にも自動で追従します）。</p>' +
    '<a class="btn" id="go" data-testid="redirect-link" target="_top" href="' + href + '">開く</a></div>' +
    '<script>try{window.top.location.href=' + redirectJsString_(target) + ';}catch(e){}</script></body></html>';
}

/**
 * doGet から呼ぶ。リダイレクトするなら案内ページの HtmlOutput、しないなら null（通常どおり表示）。例外は投げない。
 */
function redirectResponse_(e) {
  try {
    var prop = null;
    try { prop = PropertiesService.getScriptProperties().getProperty(REDIRECT_PROP_KEY_); } catch (err) { prop = null; }
    var baked = (typeof REDIRECT_URL_ === 'undefined') ? '' : REDIRECT_URL_;
    var target = redirectTarget_(e, redirectDestination_(prop, baked));
    if (!target) return null;
    // この案内ページは小さいので createHtmlOutput(文字列) でよい（本体の index は doGet で createHtmlOutputFromFile で返す）
    return HtmlService.createHtmlOutput(redirectPageHtml_(target))
      .setTitle('音声分割')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
  } catch (err2) {
    return null;
  }
}

// ============================================================================
// タブのアイコン（favicon）
//
// アイコンの URL の決め方（iconDestination_）:
//   1. スクリプト プロパティ AUDIO_SPLITTER_ICON_URL が設定されていれば、それを使う（再デプロイなしで切り替え・解除できる）。
//      値が off（大文字小文字・前後の空白は無視。リダイレクトと共用の REDIRECT_OFF_）なら、焼き込み値があってもアイコンを付けない（解除）。
//      値が不正なとき（iconNormalize_ が null を返す）は、アイコンを付けない。焼き込み値には戻さない（誤設定に気づけるようにするため）。
//      値は scripts/bundle-gas.mjs の normalizeIconUrl と同じ規則で正規化する（Drive の URL / ID → lh3 の URL、末尾に '#.png' など）。
//   2. プロパティが未設定・空なら、焼き込み値 APP_ICON_URL_（冒頭の変数。deploy.ps1 -IconUrl。ビルド時に正規化済み）をそのまま使う。
//   3. どちらも空ならアイコンを付けない。
// ============================================================================

var ICON_PROP_KEY_ = 'AUDIO_SPLITTER_ICON_URL';

/** URL（https:// で始まる文字列）をホスト名（小文字）・パス・クエリに分ける。new URL() が失敗する形は null。GAS には URL クラスが無いので文字列操作で行う。 */
function iconParseHttps_(url) {
  if (!/^https:\/\//i.test(url)) return null;
  var rest = url.slice(8).replace(/^\/+/, '');
  var hashAt = rest.indexOf('#');
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  var queryAt = rest.indexOf('?');
  var query = '';
  if (queryAt >= 0) { query = rest.slice(queryAt + 1); rest = rest.slice(0, queryAt); }
  var slashAt = rest.indexOf('/');
  var auth = slashAt >= 0 ? rest.slice(0, slashAt) : rest;
  var path = slashAt >= 0 ? rest.slice(slashAt) : '/';
  var hostport = auth.slice(auth.lastIndexOf('@') + 1);
  var host;
  var port;
  if (hostport.charAt(0) === '[') {
    var close = hostport.indexOf(']');
    if (close < 0) return null;
    host = hostport.slice(0, close + 1);
    port = hostport.slice(close + 1);
    if (!iconIpv6Ok_(host.slice(1, -1))) return null;
    if (port) { if (port.charAt(0) !== ':') return null; port = port.slice(1); }
  } else {
    var colonAt = hostport.indexOf(':');
    host = colonAt >= 0 ? hostport.slice(0, colonAt) : hostport;
    port = colonAt >= 0 ? hostport.slice(colonAt + 1) : '';
    if (host.indexOf('%') >= 0) {
      try { host = decodeURIComponent(host); } catch (err) { return null; }
    }
    // 非 ASCII（% デコード後）は IDNA の判定が要るので、ここでは通す
    if (/[\x00-\x20\x7f]/.test(host) || /[#\/:<>?@\[\\\]^|%]/.test(host)) return null;
    host = host.toLowerCase();
    if (!iconHostOk_(host)) return null;
  }
  if (!host) return null;
  if (port && (!/^\d+$/.test(port) || parseInt(port, 10) > 65535)) return null;
  return { host: host, path: iconResolveDots_(path), query: query };
}

/** IPv6 アドレス（角括弧の中身）として正しいこと。 */
function iconIpv6Ok_(a) {
  var v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (v4) {
    var octs = v4[2].split('.');
    for (var i = 0; i < 4; i++) if (octs[i].length > 3 || (octs[i].length > 1 && octs[i].charAt(0) === '0') || parseInt(octs[i], 10) > 255) return false;
    a = v4[1] + '0:0';
  }
  var halves = a.split('::');
  if (halves.length > 2) return false;
  var groups = [];
  for (var h = 0; h < halves.length; h++) if (halves[h]) groups = groups.concat(halves[h].split(':'));
  for (var g = 0; g < groups.length; g++) if (!/^[0-9A-Fa-f]{1,4}$/.test(groups[g])) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** ホスト名が空でなく、末尾が数字のとき（IPv4 とみなされる）は IPv4 として正しいこと。 */
function iconHostOk_(host) {
  if (!host) return false;
  var labels = host.split('.');
  if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop();
  var last = labels[labels.length - 1];
  if (!/^(?:\d+|0[xX][0-9A-Fa-f]*)$/.test(last)) return true;
  if (labels.length > 4) return false;
  var nums = [];
  for (var i = 0; i < labels.length; i++) {
    var l = labels[i];
    var n;
    if (/^0[xX][0-9A-Fa-f]*$/.test(l)) n = l.length === 2 ? 0 : parseInt(l.slice(2), 16);
    else if (/^0[0-7]+$/.test(l)) n = parseInt(l, 8);
    else if (/^\d+$/.test(l) && !/^0\d/.test(l)) n = parseInt(l, 10);
    else return false;
    nums.push(n);
  }
  for (var j = 0; j < nums.length - 1; j++) if (nums[j] > 255) return false;
  return nums[nums.length - 1] < Math.pow(256, 5 - nums.length);
}

/** パスの . と .. のセグメントを解決する（%2e も . として扱う。new URL() の pathname と同じ）。 */
function iconResolveDots_(path) {
  var segs = path.split('/');
  var out = [];
  for (var i = 1; i < segs.length; i++) {
    var lower = segs[i].toLowerCase();
    var isLast = i === segs.length - 1;
    if (lower === '..' || lower === '.%2e' || lower === '%2e.' || lower === '%2e%2e') { out.pop(); if (isLast) out.push(''); }
    else if (lower === '.' || lower === '%2e') { if (isLast) out.push(''); }
    else out.push(segs[i]);
  }
  return '/' + out.join('/');
}

function iconDecode_(s) {
  var t = s.replace(/\+/g, ' ');
  try { return decodeURIComponent(t); } catch (err) { return t; }
}

/** クエリ文字列から最初の id= の値を取り出す（URLSearchParams.get('id') 相当）。無ければ ''。 */
function iconQueryId_(query) {
  var pairs = query.split('&');
  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i]) continue;
    var eq = pairs[i].indexOf('=');
    var k = eq >= 0 ? pairs[i].slice(0, eq) : pairs[i];
    var v = eq >= 0 ? pairs[i].slice(eq + 1) : '';
    if (iconDecode_(k) === 'id') return iconDecode_(v);
  }
  return '';
}

/**
 * アイコンの URL を正規化する（scripts/bundle-gas.mjs の normalizeIconUrl と同じ入力に同じ結果）。
 * 空は ''、不正は null（normalizeIconUrl は例外）。
 */
function iconNormalize_(value) {
  var s = String(value == null ? '' : value).replace(/^\s+|\s+$/g, '');
  if (!s) return '';
  var extM = /#(\.(?:png|ico|jpe?g|gif))$/i.exec(s);
  var ext = extM ? extM[1].toLowerCase() : '.png';
  var body = extM ? s.slice(0, s.length - extM[0].length) : s;
  var drive = function (id) { return 'https://lh3.googleusercontent.com/d/' + id + '#' + ext; };
  if (/^[A-Za-z0-9_-]{20,200}$/.test(body)) return drive(body);
  if (!/^https:\/\//i.test(s)) return null;
  // JS 文字列リテラル・HTML 属性に入れても壊れない文字だけ許可（空白・引用符・バックスラッシュ・<> などは不可）
  if (!/^[\x21\x23-\x26\x28-\x3b\x3d\x3f-\x5b\x5d-\x7e]+$/.test(s) || s.length > 2000) return null;
  var u = iconParseHttps_(body);
  if (!u) return null;
  if (u.host === 'drive.google.com' || u.host === 'docs.google.com') {
    var m = /\/file\/d\/([A-Za-z0-9_-]{20,200})(?:[\/?#]|$)/.exec(u.path) || /^([A-Za-z0-9_-]{20,200})$/.exec(iconQueryId_(u.query));
    return m ? drive(m[1]) : null;
  }
  if (extM) return body + '#' + ext;
  if (/\.(png|ico|jpe?g|gif)$/i.test(s)) return s;
  if (s.indexOf('#') >= 0) return null;
  return s + '#.png';
}

/** スクリプト プロパティの値が「設定されているが不正」か（off と空は不正ではない）。 */
function iconPropInvalid_(propValue) {
  var prop = String(propValue == null ? '' : propValue).replace(/^\s+|\s+$/g, '');
  if (!prop || prop.toLowerCase() === REDIRECT_OFF_) return false;
  return iconNormalize_(prop) === null;
}

/**
 * アイコンの URL を決める（優先順位は上の「タブのアイコン」節のコメント）。付けないときは ''。戻り値は setFaviconUrl にそのまま渡せる。
 * @param {*} propValue スクリプト プロパティ AUDIO_SPLITTER_ICON_URL の値
 * @param {*} bakedValue 焼き込み値 APP_ICON_URL_
 */
function iconDestination_(propValue, bakedValue) {
  var prop = String(propValue == null ? '' : propValue).replace(/^\s+|\s+$/g, '');
  if (prop) {
    if (prop.toLowerCase() === REDIRECT_OFF_) return '';
    return iconNormalize_(prop) || '';
  }
  return String(bakedValue == null ? '' : bakedValue).replace(/^\s+|\s+$/g, '');
}

// ============================================================================
// Google ドライブ連携
//
// アプリ内で Drive のフォルダをたどって音声・動画ファイルを開き、分割結果を Drive のフォルダに保存するための窓口。
// 公開関数（末尾が _ でないもの。google.script.run から呼べる）:
//   getDriveStatus / listFolder / getFolderPath / searchDrive / resolveLocationInput / createFolder
//   getFileInfo / getFileChunk / beginUpload / uploadChunk / abortUpload
// 失敗時は例外を投げず { error: 日本語メッセージ, retryable?: true, code?: '...' } を返す。
//
// Drive に対して行う操作は、読み取りと「フォルダの新規作成」「ファイルの新規作成」だけ。
// 既存ファイルの上書き・名前変更・削除・移動・コピーを行う関数は無い。
//
// 【安全装置】Web アプリを「デプロイしたユーザーとして実行（USER_DEPLOYING）」で公開すると、アクセスした全員がデプロイ者の Drive を操作できてしまう。
// そのため次の三重で守る。
//   1. 実行時の検査: すべての公開関数は最初に driveGuard_() を通る。DRIVE_ENABLED_ が true で、かつ
//      実効ユーザー（スクリプトの実行権限を持つ人）とアクセスしている人のメールアドレスが一致し、どちらも空でないときだけ通る。
//      取得に失敗したときも拒否（安全側）。通らないときは Drive に一切触れない。
//   2. 焼き込みフラグ: DRIVE_ENABLED_（冒頭）を scripts/bundle-gas.mjs が false に置換できる。USER_DEPLOYING のときは deploy.ps1 が自動でそうする。
//   3. 権限そのものを外す: 無効で組み立てるときは dist/appsscript.json から Drive 連携用のスコープと Advanced Drive Service を取り除く。
// OAuth トークン（ScriptApp.getOAuthToken()）とアップロードのセッション URL はサーバーの中だけで使い、戻り値には含めない。
// ============================================================================

var DRIVE_DISABLED_MESSAGE_ = 'この配信設定では Google ドライブ連携は使えません。';
var DRIVE_DISABLED_CODE_ = 'DRIVE_DISABLED';

var DRIVE_FOLDER_MIME_ = 'application/vnd.google-apps.folder';
var DRIVE_SHORTCUT_MIME_ = 'application/vnd.google-apps.shortcut';
var DRIVE_OCTET_MIME_ = 'application/octet-stream';
// Drive の ID として受け付ける形（q へ文字列連結する・URL から取り出す前の検査。クエリインジェクション防止）。
var DRIVE_ID_RE_ = /^[-\w]{10,200}$/;
// 仮想フォルダ ID。閲覧（listFolder / getFolderPath）だけに使い、保存先・フォルダ作成の親としては拒否する。
var DRIVE_VIRTUAL_NAMES_ = {
  'shared-root': '共有ドライブ',
  'shared-with-me': '共有アイテム',
  'starred': 'スター付き',
  'recent': '最近使ったもの'
};
var DRIVE_MY_DRIVE_NAME_ = 'マイドライブ';
var DRIVE_VIRTUAL_MAX_ITEMS_ = 500;    // 仮想フォルダ 1 つの件数の上限（超えたら truncated: true）
var DRIVE_FOLDER_MAX_ITEMS_ = 5000;    // 実フォルダ 1 つの件数の上限（超えたら truncated: true）
var DRIVE_SEARCH_MAX_ITEMS_ = 100;
var DRIVE_PATH_MAX_DEPTH_ = 20;
var DRIVE_ROOT_CACHE_KEY_ = 'audio_splitter_root_id';
var DRIVE_ROOT_CACHE_TTL_SEC_ = 21600;
var driveRootIdCache_ = null;

// 拡張子 → 保存時に付ける MIME（許可リスト）。一覧で application/octet-stream を拡張子で絞るときもこの表の拡張子を使う。
// Drive は m4a を audio/x-m4a・audio/mp4・application/octet-stream とまちまちに保存するため、一覧は MIME と拡張子の両方で判定する。
var DRIVE_EXT_MIME_ = {
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  flac: 'audio/flac', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff', amr: 'audio/amr', weba: 'audio/webm',
  mka: 'audio/x-matroska', mp2: 'audio/mpeg', m4b: 'audio/mp4', ac3: 'audio/ac3',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2', wmv: 'video/x-ms-wmv', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg', flv: 'video/x-flv'
};
var DRIVE_DEFAULT_UPLOAD_NAME_ = 'audio.m4a';

var DRIVE_ALIGN_ = 256 * 1024;
var DRIVE_CHUNK_BYTES_ = 32 * DRIVE_ALIGN_;               // 8 MiB（256 KiB の倍数）
var DRIVE_MAX_CHUNK_BYTES_ = 64 * DRIVE_ALIGN_;           // 16 MiB（getFileChunk が受け付ける length の上限）
var DRIVE_MAX_TOTAL_BYTES_ = 500 * 1024 * 1024;           // 保存する 1 ファイルの上限
var DRIVE_FALLBACK_MAX_BYTES_ = 50 * 1024 * 1024;         // DriveApp フォールバック（全体読み込み）の上限
var DRIVE_SESSION_PREFIX_ = 'audio_splitter_up_';
var DRIVE_SESSION_TTL_SEC_ = 21600;                       // CacheService の最大（6 時間）
var DRIVE_DONE_TTL_SEC_ = 1800;                           // 完了済みの印を残す時間（最後のチャンクの再送に同じ結果を返すため）
var DRIVE_RESTRICTED_CODE_ = 'DOWNLOAD_RESTRICTED';
var DRIVE_RESTRICTED_MESSAGE_ = '所有者によりダウンロードが制限されているため、ファイルを取得できません。';

// ---------------------------------------------------------------- 共通（ガード・エラー・ID）

/** 例外（Error でなくても可）→ メッセージ文字列。 */
function errMessage_(e) {
  return (e && e.message) ? e.message : String(e);
}

/** 利用者の操作ミスなど、再試行しても直らないエラー（driveErrorOf_ が retryable を付けない）。 */
function driveFail_(message, code) {
  var e = new Error(message);
  e.driveFatal = true;
  if (code) e.driveCode = code;
  return e;
}

/** 例外 → { error, retryable?, code? }。driveFail_ 以外（Drive / 通信の失敗）は日本語の文言に整える。retryable は retryableDefault が true のときだけ付く。 */
function driveErrorOf_(e, retryableDefault) {
  var raw = errMessage_(e);
  var msg = raw;
  if (!(e && e.driveFatal)) {
    if (/not\s*found|404/i.test(raw)) msg = 'ファイルまたはフォルダが見つかりません（アクセス権がない可能性もあります）。';
    else if (/permission|forbidden|insufficient|403/i.test(raw)) msg = 'この操作を行う権限がありません。';
    else msg = 'Google ドライブの処理に失敗しました（' + raw.slice(0, 200) + '）';
  }
  var out = { error: msg };
  if (e && e.driveCode) out.code = e.driveCode;
  if (retryableDefault && !(e && e.driveFatal)) out.retryable = true;
  return out;
}

function driveDisabledResult_() {
  return { error: DRIVE_DISABLED_MESSAGE_, code: DRIVE_DISABLED_CODE_ };
}

/**
 * 全公開関数が最初に通すガード。通すなら null、通さないなら DRIVE_DISABLED のエラーオブジェクト。例外は投げない。
 * 通す条件: DRIVE_ENABLED_ === true、かつ 実効ユーザー と アクセスしているユーザー のメールアドレスが空でなく一致する。
 * 取得に失敗した・どちらかが空のときは「確認できない」として拒否する。
 */
function driveGuard_() {
  try {
    if (DRIVE_ENABLED_ !== true) return driveDisabledResult_();
    var effective = String(Session.getEffectiveUser().getEmail() || '').replace(/^\s+|\s+$/g, '').toLowerCase();
    var active = String(Session.getActiveUser().getEmail() || '').replace(/^\s+|\s+$/g, '').toLowerCase();
    if (!effective || !active || effective !== active) return driveDisabledResult_();
    return null;
  } catch (e) {
    return driveDisabledResult_();
  }
}

/** Drive 連携が使えるか。クライアントはこれでボタンの表示を決める。例外は投げない。 */
function getDriveStatus() {
  var g = driveGuard_();
  if (g) return { enabled: false, reason: g.error };
  return { enabled: true };
}

function driveRequireService_() {
  if (typeof Drive === 'undefined') throw driveFail_('Google ドライブのサービスが有効になっていません。管理者に連絡してください。');
}

function driveIsVirtualId_(id) {
  return Object.prototype.hasOwnProperty.call(DRIVE_VIRTUAL_NAMES_, id);
}

/** 実フォルダの ID（'root' か Drive の ID の形）を要求する。仮想 ID・空・不正な形は拒否。 */
function driveRequireFolderId_(id) {
  var s = String(id == null ? '' : id);
  if (!s || driveIsVirtualId_(s)) throw driveFail_('フォルダを指定してください。');
  if (s !== 'root' && !DRIVE_ID_RE_.test(s)) throw driveFail_('フォルダの ID が不正です。');
  return s;
}

/** ファイルの ID（Drive の ID の形）を要求する。 */
function driveRequireFileId_(id) {
  var s = String(id == null ? '' : id);
  if (!DRIVE_ID_RE_.test(s)) throw driveFail_('ファイルの ID が不正です。');
  return s;
}

/** Drive 検索クエリ（q）用の文字列リテラル（シングルクォート込み。バックスラッシュと ' をエスケープする）。 */
function driveQuote_(v) {
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** URL（/folders/<ID>・/d/<ID>・?id=<ID>）または文字列中の長い ID から Drive の ID を取り出す。無ければ ''。 */
function driveIdFromUrl_(url) {
  var s = String(url || '');
  var m = s.match(/\/(?:folders|d)\/([-\w]{10,})/) || s.match(/[?&]id=([-\w]{10,})/);
  if (m) return m[1];
  var parts = s.match(/[-\w]{25,}/);
  return (parts && parts.length > 0) ? parts[0] : '';
}

/** ファイル名を無害化する（制御文字を除き、パス区切りと Windows で使えない文字を _ に、前後の空白と末尾のドットを除き、150 文字まで）。空なら fallback。 */
function driveSanitizeName_(name, fallback) {
  var s = String(name == null ? '' : name);
  s = s.replace(/[\u0000-\u001F\u007F]/g, '');
  s = s.replace(/[\/\\:*?"<>|]/g, '_');
  s = s.replace(/^\s+|\s+$/g, '');
  if (s.length > 150) {
    // 切り詰めても拡張子は残す（拡張子から MIME を決めるので、切れると保存できなくなる）
    var em = /\.[A-Za-z0-9]{1,10}$/.exec(s);
    var ext = em ? em[0] : '';
    s = s.slice(0, 150 - ext.length).replace(/\s+$/, '') + ext;
  }
  return s || fallback;
}

function driveExtOf_(name) {
  var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 拡張子 → 保存時の MIME。許可リストに無ければ null。 */
function driveMimeForName_(name) {
  var ext = driveExtOf_(name);
  return (ext && Object.prototype.hasOwnProperty.call(DRIVE_EXT_MIME_, ext)) ? DRIVE_EXT_MIME_[ext] : null;
}

/** フォルダ・ショートカットを除くファイルが、一覧に出す種類（音声・動画らしいもの）か。Google ドキュメント形式は false。 */
function driveAcceptsFile_(mime, name) {
  var m = String(mime || '').toLowerCase();
  if (m.indexOf('audio/') === 0 || m.indexOf('video/') === 0 || m === 'application/ogg') return true;
  if (m === DRIVE_OCTET_MIME_) return driveMimeForName_(name) !== null;
  return false;
}

/** files.list の q に入れる「扱う種類」の条件（括弧つき）。ショートカットも拾う（ターゲットの種類での絞り込みは driveItemFor_）。 */
function driveTypeQuery_(foldersOnly) {
  var conds = ["mimeType = '" + DRIVE_FOLDER_MIME_ + "'"];
  if (!foldersOnly) {
    conds.push("mimeType contains 'audio/'", "mimeType contains 'video/'", "mimeType = 'application/ogg'", "mimeType = '" + DRIVE_OCTET_MIME_ + "'");
  }
  conds.push("mimeType = '" + DRIVE_SHORTCUT_MIME_ + "'");
  return '(' + conds.join(' or ') + ')';
}

function driveToMillis_(iso) {
  if (!iso) return null;
  var t = new Date(iso).getTime();
  return isNaN(t) ? null : t;
}

function driveFoldersOnly_(options) {
  return !!(options && typeof options === 'object' && options.foldersOnly === true);
}

var DRIVE_ITEM_FIELDS_ = 'id,name,mimeType,size,modifiedTime,driveId,capabilities(canDownload,canAddChildren),shortcutDetails(targetId,targetMimeType)';

/** files リソース 1 件（ショートカットでない）→ 一覧項目。 */
function driveItemFromFile_(f) {
  var isFolder = f.mimeType === DRIVE_FOLDER_MIME_;
  var caps = f.capabilities || {};
  var item = {
    id: f.id,
    name: f.name,
    type: isFolder ? 'folder' : 'file',
    mimeType: f.mimeType,
    size: (!isFolder && f.size != null && f.size !== '' && isFinite(Number(f.size))) ? Number(f.size) : null,
    updated: driveToMillis_(f.modifiedTime),
    canDownload: caps.canDownload !== false
  };
  if (isFolder) item.canAddChildren = caps.canAddChildren === true;
  if (f.driveId) item.driveId = f.driveId;
  return item;
}

/**
 * files リソース 1 件 → 一覧項目。扱わない種類は null。
 * ショートカットは、ターゲットの ID・MIME の項目にする（名前はショートカットのもの。shortcut: true）。
 * ターゲットが対象外の種類なら null。ターゲットの権限は分からないので、フォルダなら canAddChildren は false。
 */
function driveItemFor_(f, foldersOnly) {
  if (f.mimeType === DRIVE_SHORTCUT_MIME_) {
    var sd = f.shortcutDetails;
    if (!sd || !sd.targetId || !DRIVE_ID_RE_.test(String(sd.targetId))) return null;
    var isFolder = sd.targetMimeType === DRIVE_FOLDER_MIME_;
    if (foldersOnly && !isFolder) return null;
    if (!isFolder && !driveAcceptsFile_(sd.targetMimeType, f.name)) return null;
    var sc = {
      id: sd.targetId,
      name: f.name,
      type: isFolder ? 'folder' : 'file',
      mimeType: sd.targetMimeType,
      size: null,
      updated: driveToMillis_(f.modifiedTime),
      canDownload: true
    };
    if (isFolder) sc.canAddChildren = false;
    sc.shortcut = true;
    return sc;
  }
  if (f.mimeType !== DRIVE_FOLDER_MIME_ && (foldersOnly || !driveAcceptsFile_(f.mimeType, f.name))) return null;
  return driveItemFromFile_(f);
}

/** フォルダ → ファイルの順、同じ種類は名前順。 */
function driveSortItems_(items) {
  return items.sort(function (a, b) {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

/**
 * Drive の list 系 API を nextPageToken で最後まで辿る（kind = 'Files' → Drive.Files.list / 'Drives' → Drive.Drives.list）。
 * 各ページの応答を onPage(resp) に渡す。onPage が false を返したら止める。戻り値: 続き（nextPageToken）が残っているか。
 */
function driveEachPage_(kind, args, onPage) {
  var token = null;
  do {
    var a = {};
    Object.keys(args).forEach(function (k) { a[k] = args[k]; });
    if (token) a.pageToken = token;
    var resp = Drive[kind].list(a) || {};
    token = resp.nextPageToken || null;
    if (onPage(resp) === false) return !!token;
  } while (token);
  return false;
}

/** マイドライブのルート ID。実行インスタンス内の変数 → CacheService（ユーザー単位・6 時間）→ Drive の順に引く。 */
function driveRootId_() {
  if (driveRootIdCache_) return driveRootIdCache_;
  var cache = null;
  try { if (typeof CacheService !== 'undefined') cache = CacheService.getUserCache(); } catch (e0) { cache = null; }
  if (cache) {
    try {
      var hit = cache.get(DRIVE_ROOT_CACHE_KEY_);
      if (hit) { driveRootIdCache_ = hit; return hit; }
    } catch (e1) { /* キャッシュは任意 */ }
  }
  driveRootIdCache_ = Drive.Files.get('root', { fields: 'id' }).id;
  if (cache) {
    try { cache.put(DRIVE_ROOT_CACHE_KEY_, driveRootIdCache_, DRIVE_ROOT_CACHE_TTL_SEC_); } catch (e2) { /* ignore */ }
  }
  return driveRootIdCache_;
}

// ---------------------------------------------------------------- 一覧・検索・場所の解決

/**
 * フォルダの中身（フォルダと音声・動画ファイル）。folderId は 'root' / 実 ID / 仮想フォルダ（shared-root / shared-with-me / starred / recent）。
 * options.foldersOnly: true のときはフォルダ（とフォルダを指すショートカット）だけ。並びはフォルダ → 名前順。
 * @return {{folder:Object,items:Array,truncated?:true}|{error:string,code?:string}}
 */
function listFolder(folderId, options) {
  var g = driveGuard_();
  if (g) return g;
  try {
    driveRequireService_();
    var foldersOnly = driveFoldersOnly_(options);
    var raw = String(folderId == null || folderId === '' ? 'root' : folderId);
    if (driveIsVirtualId_(raw)) return driveListVirtual_(raw, foldersOnly);
    var id = driveRequireFolderId_(raw);

    var meta = Drive.Files.get(id, { fields: 'id,name,parents,driveId,capabilities(canAddChildren)', supportsAllDrives: true });
    var rootId = driveRootId_();
    var folder = {
      id: meta.id,
      name: meta.id === rootId ? DRIVE_MY_DRIVE_NAME_ : meta.name,
      parentId: (meta.parents && meta.parents.length) ? meta.parents[0] : null,
      isRoot: meta.id === rootId || !!(meta.driveId && meta.driveId === meta.id),
      driveId: meta.driveId || null,
      canAddChildren: !!(meta.capabilities && meta.capabilities.canAddChildren === true)
    };

    var items = [];
    var extra = false;
    var more = driveEachPage_('Files', {
      q: driveQuote_(meta.id) + ' in parents and trashed = false and ' + driveTypeQuery_(foldersOnly),
      pageSize: 1000,
      fields: 'nextPageToken,files(' + DRIVE_ITEM_FIELDS_ + ')',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      orderBy: 'folder,name'
    }, function (resp) {
      (resp.files || []).forEach(function (f) {
        var it = driveItemFor_(f, foldersOnly);
        if (!it) return;
        if (items.length >= DRIVE_FOLDER_MAX_ITEMS_) { extra = true; return; }
        items.push(it);
      });
      return !extra;
    });
    driveSortItems_(items);   // orderBy ではショートカットが（フォルダを指していても）ファイルの側に並ぶので並べ直す
    var out = { folder: folder, items: items };
    if (extra || (more && items.length >= DRIVE_FOLDER_MAX_ITEMS_)) out.truncated = true;
    return out;
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}

/** 仮想フォルダ（共有ドライブの一覧 / 共有アイテム / スター付き / 最近使ったもの）の一覧。 */
function driveListVirtual_(id, foldersOnly) {
  var folder = { id: id, name: DRIVE_VIRTUAL_NAMES_[id], parentId: null, isRoot: true, driveId: null, canAddChildren: false };
  var items = [];
  var truncated = false;
  var typeCond = driveTypeQuery_(foldersOnly);
  var add = function (it) {
    if (!it) return;
    if (items.length >= DRIVE_VIRTUAL_MAX_ITEMS_) { truncated = true; return; }
    items.push(it);
  };

  if (id === 'starred' || id === 'shared-with-me') {
    var q = (id === 'starred' ? 'starred = true' : 'sharedWithMe = true') + ' and trashed = false and ' + typeCond;
    var more = driveEachPage_('Files', {
      q: q, pageSize: 200, fields: 'nextPageToken,files(' + DRIVE_ITEM_FIELDS_ + ')', includeItemsFromAllDrives: true, supportsAllDrives: true
    }, function (resp) {
      (resp.files || []).forEach(function (f) { add(driveItemFor_(f, foldersOnly)); });
      return !truncated && items.length < DRIVE_VIRTUAL_MAX_ITEMS_;
    });
    if (more && items.length >= DRIVE_VIRTUAL_MAX_ITEMS_) truncated = true;
    driveSortItems_(items);
  } else if (id === 'recent') {
    // 一度も開いていない項目（viewedByMeTime が null）を除くため、十分古い日時との比較で絞る。最近見た順のまま返す
    var rResp = Drive.Files.list({
      q: "trashed = false and viewedByMeTime > '2000-01-01T00:00:00' and " + typeCond,
      orderBy: 'viewedByMeTime desc',
      pageSize: 100,
      fields: 'nextPageToken,files(' + DRIVE_ITEM_FIELDS_ + ')',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    }) || {};
    (rResp.files || []).forEach(function (f) { add(driveItemFor_(f, foldersOnly)); });
    if (rResp.nextPageToken) truncated = true;
  } else if (id === 'shared-root') {
    var moreDrives = driveEachPage_('Drives', { pageSize: 100, fields: 'nextPageToken,drives(id,name,capabilities(canAddChildren))' }, function (dResp) {
      (dResp.drives || []).forEach(function (d) {
        if (!d || !d.id) return;
        add({
          id: d.id, name: d.name, type: 'folder', mimeType: DRIVE_FOLDER_MIME_, size: null, updated: null,
          canDownload: true, canAddChildren: !!(d.capabilities && d.capabilities.canAddChildren === true), driveId: d.id
        });
      });
      return !truncated && items.length < DRIVE_VIRTUAL_MAX_ITEMS_;
    });
    if (moreDrives && items.length >= DRIVE_VIRTUAL_MAX_ITEMS_) truncated = true;
    driveSortItems_(items);
  }
  var out = { folder: folder, items: items };
  if (truncated) out.truncated = true;
  return out;
}

/**
 * ルートまでのパンくず（上位 → そのフォルダ自身）。マイドライブのルートは { id:'root', name:'マイドライブ' }。共有ドライブのルートで止める。
 * 親にアクセスできなければそこで打ち切る（最大 20 階層）。仮想フォルダ ID が渡されたら、その 1 要素だけ返す。
 */
function getFolderPath(folderId) {
  var g = driveGuard_();
  if (g) return g;
  try {
    var s = String(folderId == null || folderId === '' ? 'root' : folderId);
    if (driveIsVirtualId_(s)) return { path: [{ id: s, name: DRIVE_VIRTUAL_NAMES_[s] }] };
    driveRequireService_();
    var start = driveRequireFolderId_(s);
    var rootId = driveRootId_();
    var path = [];
    var cur = start;
    for (var depth = 0; depth < DRIVE_PATH_MAX_DEPTH_; depth++) {
      var meta;
      try {
        meta = Drive.Files.get(cur, { fields: 'id,name,parents,driveId', supportsAllDrives: true });
      } catch (e1) {
        if (depth === 0) throw e1;   // 対象のフォルダ自身が取れないのはエラー
        break;                       // 親にアクセスできない: ここまでで打ち切る
      }
      if (meta.id === rootId) { path.unshift({ id: 'root', name: DRIVE_MY_DRIVE_NAME_ }); break; }
      path.unshift({ id: meta.id, name: meta.name });
      if (meta.driveId && meta.driveId === meta.id) break;   // 共有ドライブのルート
      if (!meta.parents || !meta.parents.length) break;
      cur = meta.parents[0];
    }
    return { path: path };
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}

/**
 * 名前の一部で、ドライブ全体（マイドライブ・共有アイテム・共有ドライブ）からフォルダと音声・動画ファイルを探す。
 * 結果はフォルダ → 名前の順で最大 100 件。超えた（または Drive が検索を打ち切った）ときは truncated: true。
 */
function searchDrive(query, options) {
  var g = driveGuard_();
  if (g) return g;
  try {
    driveRequireService_();
    var foldersOnly = driveFoldersOnly_(options);
    var term = String(query == null ? '' : query).replace(/^\s+|\s+$/g, '');
    if (!term) throw driveFail_('検索語を入力してください。');
    if (term.length > 256) throw driveFail_('検索語が長すぎます。');
    var resp = Drive.Files.list({
      q: 'name contains ' + driveQuote_(term) + ' and trashed = false and ' + driveTypeQuery_(foldersOnly),
      pageSize: DRIVE_SEARCH_MAX_ITEMS_,
      orderBy: 'folder,name',
      corpora: 'allDrives',   // 共有ドライブの中も探す（既定の corpora は共有ドライブの項目を含まない）
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'nextPageToken,incompleteSearch,files(' + DRIVE_ITEM_FIELDS_ + ')'
    }) || {};
    var items = [];
    (resp.files || []).forEach(function (f) {
      var it = driveItemFor_(f, foldersOnly);
      if (it) items.push(it);
    });
    driveSortItems_(items);
    return { query: term, items: items, truncated: !!(resp.nextPageToken || resp.incompleteSearch) };
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}

/**
 * Drive の URL か ID から場所を特定する。フォルダなら { kind:'folder', id, name }、音声・動画ファイルなら { kind:'file', item, parentId }。
 * ショートカットはターゲットへ解決する。対象外の種類のファイルは { error }。
 */
function resolveLocationInput(text) {
  var g = driveGuard_();
  if (g) return g;
  try {
    driveRequireService_();
    var msg = 'フォルダまたは音声・動画ファイルの URL・ID を指定してください。';
    var s = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
    if (!s || s.length > 2048) throw driveFail_(msg);
    var id = (s === 'root' || DRIVE_ID_RE_.test(s)) ? s : driveIdFromUrl_(s);
    if (id !== 'root' && !DRIVE_ID_RE_.test(id || '')) throw driveFail_(msg);
    var fields = 'id,name,mimeType,size,modifiedTime,parents,driveId,capabilities(canDownload,canAddChildren),shortcutDetails(targetId,targetMimeType)';
    var meta = Drive.Files.get(id, { fields: fields, supportsAllDrives: true });
    if (meta.mimeType === DRIVE_SHORTCUT_MIME_ && meta.shortcutDetails && meta.shortcutDetails.targetId) {
      var tid = String(meta.shortcutDetails.targetId);
      if (!DRIVE_ID_RE_.test(tid)) throw driveFail_(msg);
      meta = Drive.Files.get(tid, { fields: fields, supportsAllDrives: true });
    }
    if (meta.mimeType === DRIVE_FOLDER_MIME_) {
      return { kind: 'folder', id: meta.id, name: meta.id === driveRootId_() ? DRIVE_MY_DRIVE_NAME_ : meta.name };
    }
    if (meta.mimeType !== DRIVE_SHORTCUT_MIME_ && driveAcceptsFile_(meta.mimeType, meta.name)) {
      return { kind: 'file', item: driveItemFromFile_(meta), parentId: (meta.parents && meta.parents[0]) || null };
    }
    throw driveFail_(msg);
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}

/** フォルダを新規作成する（保存先を選ぶ画面用）。親は 'root' か実 ID（仮想フォルダは不可）。名前は無害化する。 */
function createFolder(parentId, name) {
  var g = driveGuard_();
  if (g) return g;
  try {
    driveRequireService_();
    var parent = driveRequireFolderId_(parentId);
    var safeName = driveSanitizeName_(name, '');
    if (!safeName) throw driveFail_('フォルダ名を入力してください。');
    var created = Drive.Files.create(
      { name: safeName, mimeType: DRIVE_FOLDER_MIME_, parents: [parent] },
      null,
      { supportsAllDrives: true, fields: 'id,name' }
    );
    return { success: true, id: created.id, name: created.name };
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}

// ---------------------------------------------------------------- 読み込み（ダウンロード）

function driveAuth_() {
  return { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
}

function driveInt_(v, name, min, max) {
  var n = (typeof v === 'number' || typeof v === 'string') ? Number(v) : NaN;
  if (typeof v === 'string' && v.replace(/\s/g, '') === '') n = NaN;
  if (!isFinite(n) || Math.floor(n) !== n || n < min || n > max) throw driveFail_(name + ' が不正です。');
  return n;
}

function driveIsRetryableStatus_(code) {
  return code === 429 || code >= 500;
}

/** Drive のメタデータ。ショートカットはターゲットへ解決する（連鎖は 3 段まで）。 */
function driveGetFileMeta_(fileId, depth) {
  var id = driveRequireFileId_(fileId);
  var m = Drive.Files.get(id, {
    supportsAllDrives: true,
    fields: 'id,name,mimeType,size,parents,modifiedTime,capabilities(canDownload),shortcutDetails(targetId,targetMimeType)'
  });
  if (m.mimeType === DRIVE_SHORTCUT_MIME_ && m.shortcutDetails && m.shortcutDetails.targetId) {
    if ((depth || 0) >= 3) throw driveFail_('ショートカットをたどれませんでした。');
    return driveGetFileMeta_(m.shortcutDetails.targetId, (depth || 0) + 1);
  }
  return m;
}

function driveRestrictedResult_() {
  return { error: DRIVE_RESTRICTED_MESSAGE_, code: DRIVE_RESTRICTED_CODE_ };
}

/** 取得に失敗したとき、原因が「ダウンロード制限」か確かめて結果を作る（メタデータ 1 回。確かめられなければ null）。 */
function driveRestrictedCheck_(fileId) {
  try {
    if (typeof Drive === 'undefined') return null;
    var m = Drive.Files.get(String(fileId), { supportsAllDrives: true, fields: 'capabilities(canDownload)' });
    if (m && m.capabilities && m.capabilities.canDownload === false) return driveRestrictedResult_();
  } catch (e2) { /* 確かめられなければ元のエラーを返す */ }
  return null;
}

/**
 * 読み込み前の情報。サイズが分からないファイル・音声動画でないファイルはエラー。ダウンロード禁止は code: 'DOWNLOAD_RESTRICTED'。
 * ショートカットの ID はターゲットに解決し、返す id はターゲットのもの。
 */
function getFileInfo(fileId) {
  var g = driveGuard_();
  if (g) return g;
  try {
    driveRequireService_();
    var m = driveGetFileMeta_(fileId, 0);
    if (m.mimeType === DRIVE_FOLDER_MIME_ || !driveAcceptsFile_(m.mimeType, m.name)) throw driveFail_('音声・動画ファイルではありません。');
    if (m.capabilities && m.capabilities.canDownload === false) return driveRestrictedResult_();
    var size = Number(m.size);
    if (!isFinite(size) || size <= 0) throw driveFail_('ファイルのサイズを取得できません（空のファイル、または読み込めない形式です）。');
    return {
      success: true,
      id: m.id,
      name: m.name,
      size: size,
      mimeType: m.mimeType,
      updated: driveToMillis_(m.modifiedTime),
      parentId: (m.parents && m.parents[0]) || null,
      chunkSize: DRIVE_CHUNK_BYTES_
    };
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}

/** UrlFetchApp 応答の ETag ヘッダ（大文字小文字を問わない）。無ければ null。 */
function driveEtagOf_(resp) {
  try {
    var h = resp.getHeaders() || {};
    var v = h['ETag'] || h['Etag'] || h['etag'] || h['ETAG'];
    return v ? String(v) : null;
  } catch (e) {
    return null;
  }
}

/** files.get?alt=media を Range 付きで読む。 */
function driveFetchRange_(id, off, len) {
  return UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', {
    headers: Object.assign({ Range: 'bytes=' + off + '-' + (off + len - 1) }, driveAuth_()),
    muteHttpExceptions: true
  });
}

/** 一時的な混雑・サーバーの不調を表す状態コード（再試行すれば通る見込みがあるもの） */
function driveIsTransientStatus_(code) {
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 504;
}

/** 403 の本文が「利用回数の上限」（rateLimitExceeded / userRateLimitExceeded）か。読めなければ false。 */
function driveIsRateLimitBody_(resp) {
  try {
    return /rateLimitExceeded/i.test(String(resp.getContentText() || ''));
  } catch (e) {
    return false;
  }
}

function driveTransientResult_() {
  return { error: 'Google ドライブが混み合っているか、一時的に応答がありません。しばらくしてからやり直してください。', retryable: true };
}

/**
 * ファイルの [offset, offset+length) を base64 で返す。EOF を越える分は切り詰め、offset >= size なら空データ。
 * partial: Range が効いたか（206 / 416 = true、全体を取得して slice = false）。etag: 取得中の更新（版の混在）の検出用。
 * 通信系の失敗は retryable: true。ダウンロード禁止は code: 'DOWNLOAD_RESTRICTED'。
 */
function getFileChunk(fileId, offset, length) {
  var g = driveGuard_();
  if (g) return g;
  var id, off, len;
  try {
    id = driveRequireFileId_(fileId);
    off = driveInt_(offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    len = driveInt_(length, 'length', 1, DRIVE_MAX_CHUNK_BYTES_);
  } catch (ve) {
    return driveErrorOf_(ve, false);
  }
  try {
    var bytes = null;
    var etag = null;
    var partial = false;
    try {
      var r;
      try {
        r = driveFetchRange_(id, off, len);
      } catch (fe) {
        // UrlFetchApp が例外（タイムアウト・通信エラー）: 一時的な失敗として返す。DriveApp で全体を読み直さない
        return driveTransientResult_();
      }
      var code = r.getResponseCode();
      // 一時的な混雑・サーバーの不調（429 / 500 / 502 / 503 / 504）は、DriveApp で全体を読むフォールバックに入らず retryable で返す。
      // 画面側が間隔を空けて再試行し、同時実行数も絞る。403 のうち「利用回数の上限」（rateLimitExceeded）も同じ扱い。
      if (driveIsTransientStatus_(code) || (code === 403 && driveIsRateLimitBody_(r))) return driveTransientResult_();
      if (code !== 200 && code !== 206 && code !== 416 && typeof Drive !== 'undefined') {
        // ショートカットの ID だったときはターゲットで読み直す（普通のファイルでは余計な呼び出しをしない）
        try {
          var sm = Drive.Files.get(id, { supportsAllDrives: true, fields: 'mimeType,shortcutDetails(targetId)' });
          if (sm && sm.mimeType === DRIVE_SHORTCUT_MIME_ && sm.shortcutDetails && DRIVE_ID_RE_.test(String(sm.shortcutDetails.targetId))) {
            id = String(sm.shortcutDetails.targetId);
            r = driveFetchRange_(id, off, len);
            code = r.getResponseCode();
          }
        } catch (se) { /* 確かめられなければ元の応答で続ける */ }
        if (driveIsTransientStatus_(code)) return driveTransientResult_();
      }
      // 404（無い・見えない）は DriveApp で読んでも同じ結果なので、フォールバックせずに返す（再試行も不要）。
      if (code === 404) return driveErrorOf_(driveFail_('ファイルまたはフォルダが見つかりません（アクセス権がない可能性もあります）。'), false);
      if (code === 206 || code === 200 || code === 416) etag = driveEtagOf_(r);
      if (code === 206) {
        bytes = r.getContent();
        partial = true;
      } else if (code === 416) {
        bytes = [];   // offset が EOF 以降
        partial = true;
      } else if (code === 200) {
        bytes = r.getContent().slice(off, off + len);   // Range が無視された（全体が返った）場合は自前で slice
      }
    } catch (fe2) {
      // 応答の読み取りに失敗した等。一時的なもの（429・5xx・通信例外）は上で返し済みなので、ここに来るのは想定外の形だけ。DriveApp で拾う
    }
    if (bytes === null) {
      // フォールバック: DriveApp（Range 取得が使えない環境・権限の揺れ対策）。全体を読むので上限を設ける。
      // 入るのは 400 / 401 / 403（利用回数の上限以外）/ その他の 4xx など「Range 付きの取得そのものが通らない」ときだけ。
      // 429・5xx・通信例外は一時的なので入らない（1 チャンクごとに最大 50 MB を読み直すのを避ける）。404 は同じ結果なので入らない。
      var f2 = DriveApp.getFileById(id);
      if (f2.getSize() > DRIVE_FALLBACK_MAX_BYTES_) {
        throw new Error('ファイルが大きいため取得できませんでした（分割取得が利用できません）。時間をおいて再試行してください。');
      }
      bytes = f2.getBlob().getBytes().slice(off, off + len);
    }
    return { success: true, offset: off, length: bytes.length, data: bytes.length ? Utilities.base64Encode(bytes) : '', etag: etag, partial: partial };
  } catch (e) {
    // 403 などで取れなかった原因がダウンロード制限なら、再試行不要の専用コードで返す
    return driveRestrictedCheck_(id) || driveErrorOf_(e, true);
  }
}

// ---------------------------------------------------------------- 保存（新規ファイルのアップロード）

function driveSessionKey_(token) {
  if (!/^[A-Za-z0-9-]{16,64}$/.test(String(token || ''))) throw driveFail_('アップロードのトークンが不正です。');
  return DRIVE_SESSION_PREFIX_ + token;
}

function driveGetSession_(token) {
  var raw = CacheService.getUserCache().get(driveSessionKey_(token));
  if (!raw) throw driveFail_('アップロードのセッションが見つかりません（期限切れ）。最初からやり直してください。');
  return JSON.parse(raw);
}

function drivePutSession_(token, sess, ttlSec) {
  CacheService.getUserCache().put(driveSessionKey_(token), JSON.stringify(sess), ttlSec || DRIVE_SESSION_TTL_SEC_);
}

/**
 * 完了したセッションを、Drive のセッション URL を含まない「完了済み」の印に置き換える。
 * 最後のチャンクを Drive が受け取ったのに応答だけが失われると、クライアントは同じチャンクを再送する。
 * そのとき「セッションが見つかりません」にせず、同じ結果（file）を返せるようにするため（印は短時間で消える）。
 */
function driveFinishSession_(token, sess, file) {
  drivePutSession_(token, { done: true, total: sess.total, file: file }, DRIVE_DONE_TTL_SEC_);
}

/** Range ヘッダ（'bytes=0-N'）から次の送信オフセットを得る。ヘッダ無しは 0。 */
function driveNextFromRange_(resp) {
  var h = resp.getHeaders() || {};
  var range = h['Range'] || h['range'];
  var m = range && String(range).match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

function driveFileFromResponse_(resp) {
  var f = JSON.parse(resp.getContentText() || '{}');
  return { id: f.id, name: f.name };
}

/** セッションの受信済みバイト数を Drive に問い合わせる。完了済みなら { done:true, file }。 */
function driveQueryStatus_(sess) {
  var r = UrlFetchApp.fetch(sess.url, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + sess.total },
    payload: '',
    followRedirects: false,   // 308 を「リダイレクト」として追従させない
    muteHttpExceptions: true
  });
  var code = r.getResponseCode();
  if (code === 200 || code === 201) return { done: true, file: driveFileFromResponse_(r) };
  if (code === 308) return { done: false, next: driveNextFromRange_(r) };
  if (code === 404 || code === 410) throw driveFail_('アップロードのセッションの期限が切れました。最初からやり直してください。');
  throw new Error('アップロード状態を取得できません（' + code + '）');
}

/**
 * 新規ファイルのアップロードを始める（既存ファイルの上書きはできない）。meta: { folderId, name, size }。
 * MIME はクライアントの申告を使わず、ファイル名の拡張子から決める（音声・動画の許可リスト。該当しなければエラー）。
 * 同名のファイルがあっても検査しない（Drive は同名を許す。重複の回避はクライアント側）。
 * Drive のセッション URL はサーバー（CacheService のユーザーキャッシュ）に保存し、クライアントには不透明なトークンだけ返す。
 */
function beginUpload(meta) {
  var g = driveGuard_();
  if (g) return g;
  try {
    driveRequireService_();
    meta = (meta && typeof meta === 'object') ? meta : {};
    var size = driveInt_(meta.size, 'size', 1, DRIVE_MAX_TOTAL_BYTES_);
    var parent = driveRequireFolderId_(meta.folderId);
    var name = driveSanitizeName_(meta.name, DRIVE_DEFAULT_UPLOAD_NAME_);
    var mime = driveMimeForName_(name);
    if (!mime) throw driveFail_('保存できるのは音声・動画ファイルだけです（対応していない拡張子です）。');

    var r = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name', {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: Object.assign({ 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) }, driveAuth_()),
      payload: JSON.stringify({ name: name, mimeType: mime, parents: [parent] }),
      muteHttpExceptions: true
    });
    var code = r.getResponseCode();
    if (code !== 200) {
      var text = '';
      try { text = String(r.getContentText() || '').slice(0, 200); } catch (e0) { text = ''; }
      var res;
      if (code === 404) res = { error: '保存先のフォルダが見つかりません（アクセス権がない可能性もあります）。' };
      else if (code === 403) res = { error: '保存先のフォルダに書き込む権限がありません。' };
      else res = { error: 'アップロードを開始できません（' + code + '）' + (text ? ': ' + text : '') };
      if (driveIsRetryableStatus_(code)) res.retryable = true;
      return res;
    }
    var h = r.getHeaders() || {};
    var loc = h['Location'] || h['location'];
    if (!loc) throw new Error('アップロードのセッションが作成されませんでした。');
    var token = Utilities.getUuid();
    drivePutSession_(token, { url: loc, total: size, next: 0, mime: mime });
    return { success: true, token: token, chunkSize: DRIVE_CHUNK_BYTES_ };
  } catch (e) {
    return driveErrorOf_(e, true);
  }
}

/**
 * 1 チャンクを送る。最終チャンク以外は 256 KiB の倍数。
 * 再送に安全: サーバーが受信済みの範囲と食い違う offset が来たら（応答だけ失われた場合など）、Drive に状態を問い合わせて
 * { done:false, next } を返す。クライアントは返った next から続ける。UrlFetchApp が例外を投げたとき（Drive が受け取ったか不明）も、
 * 次の呼び出しは先に状態を問い合わせる。完了時は file: { id, name } を返し、セッションは「完了済み」の印（URL なし・短時間）に置き換える
 * （最後のチャンクの応答が失われて再送されても、同じ結果を返すため）。
 */
function uploadChunk(token, offset, base64, total) {
  var g = driveGuard_();
  if (g) return g;
  try {
    var sess = driveGetSession_(token);
    var tot = driveInt_(total, 'total', 1, DRIVE_MAX_TOTAL_BYTES_);
    if (tot !== sess.total) throw driveFail_('total がセッションと一致しません。');
    // 完了済み（最後のチャンクの応答だけが失われて、クライアントが再送してきた）: 同じ結果を返す。データは送り直さない
    if (sess.done === true) return { success: true, done: true, next: tot, file: sess.file };
    var off = driveInt_(offset, 'offset', 0, tot - 1);
    var bytes = Utilities.base64Decode(String(base64 || '').replace(/\s/g, ''));
    var n = bytes.length;
    if (n < 1 || off + n > tot) throw driveFail_('チャンクの範囲が不正です。');
    var isLast = off + n === tot;
    if (!isLast && n % DRIVE_ALIGN_ !== 0) throw driveFail_('チャンクのサイズは 256 KiB の倍数にしてください。');

    if (sess.next !== off) {
      var st = driveQueryStatus_(sess);
      if (st.done) {
        driveFinishSession_(token, sess, st.file);
        return { success: true, done: true, next: tot, file: st.file };
      }
      sess.next = st.next;
      drivePutSession_(token, sess);
      if (off !== sess.next) return { success: true, done: false, next: sess.next };   // クライアントが next から再開
    }

    var r;
    try {
      r = UrlFetchApp.fetch(sess.url, {
        method: 'put',
        contentType: 'application/octet-stream',
        headers: { 'Content-Range': 'bytes ' + off + '-' + (off + n - 1) + '/' + tot },
        payload: bytes,
        followRedirects: false,   // 308 を「リダイレクト」として追従させない
        muteHttpExceptions: true
      });
    } catch (fe) {
      // 通信の例外（タイムアウトなど）: Drive がこのチャンクを受け取ったかどうか分からない。
      // 記録の next のまま再送すると、受信済みの範囲に重なる PUT になる（Drive が拒否する可能性がある）ので、
      // 次回は先に Drive へ状態を問い合わせさせる。
      sess.next = -1;
      try { drivePutSession_(token, sess); } catch (pe) { /* 記録できなくても元の例外を返す */ }
      throw fe;
    }
    var code = r.getResponseCode();
    if (code === 200 || code === 201) {
      var file = driveFileFromResponse_(r);
      driveFinishSession_(token, sess, file);
      return { success: true, done: true, next: tot, file: file };
    }
    if (code === 308) {
      sess.next = driveNextFromRange_(r);
      drivePutSession_(token, sess);
      return { success: true, done: false, next: sess.next };
    }
    sess.next = -1;   // 状態不明 → 次回 Drive に問い合わせさせる
    drivePutSession_(token, sess);
    if (code === 404 || code === 410) throw driveFail_('アップロードのセッションの期限が切れました。最初からやり直してください。');
    var res = { error: 'チャンクの送信に失敗しました（' + code + '）' };
    if (driveIsRetryableStatus_(code)) res.retryable = true;
    return res;
  } catch (e) {
    return driveErrorOf_(e, true);
  }
}

/** アップロードを取り消す（セッションを破棄する。Drive 側のセッションの DELETE はベストエフォート）。 */
function abortUpload(token) {
  var g = driveGuard_();
  if (g) return g;
  try {
    var key = driveSessionKey_(token);
    var raw = CacheService.getUserCache().get(key);
    if (raw) {
      try {
        var url = JSON.parse(raw).url;   // 完了済みの印には URL が無い（Drive へは何も送らない）
        if (url) UrlFetchApp.fetch(url, { method: 'delete', followRedirects: false, muteHttpExceptions: true });
      } catch (e1) { /* ignore */ }
      CacheService.getUserCache().remove(key);
    }
    return { success: true };
  } catch (e) {
    return driveErrorOf_(e, false);
  }
}
