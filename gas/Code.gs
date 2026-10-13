// 配信専用。音声処理はすべてブラウザ側で行い、GAS は HTML を返すだけ（サーバー側の業務ロジックなし）。
// このファイルに、HTML を返す doGet、旧デプロイ → 新デプロイへのリダイレクト（下の「リダイレクト」節）、
// タブのアイコンの決定（下の「タブのアイコン」節）が入っている。
//
// 次の 2 行は scripts/bundle-gas.mjs が dist/Code.gs でのみ差し替える（deploy.ps1 の -IconUrl / -RedirectUrl）。
// このソース（gas/Code.gs）自体は書き換わらない。行の形を変えるとビルドが止まるので、そのまま残すこと。
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
