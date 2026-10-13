// 配信専用。音声処理はすべてブラウザ側で行い、GAS は HTML を返すだけ（サーバー側の業務ロジックなし）。
// このファイルに、HTML を返す doGet と、旧デプロイ → 新デプロイへのリダイレクト（下の「リダイレクト」節）が入っている。
//
// 次の 2 行は scripts/bundle-gas.mjs が dist/Code.gs でのみ差し替える（deploy.ps1 の -IconUrl / -RedirectUrl）。
// このソース（gas/Code.gs）自体は書き換わらない。行の形を変えるとビルドが止まるので、そのまま残すこと。
// タブのアイコン（favicon）の URL。https のみ。空なら Apps Script 既定のアイコンのまま。
// GAS は URL 末尾の拡張子（png / ico / jpg / gif）を検査するため、bundle-gas.mjs が末尾に '#.png' などを足す。
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

  // デプロイ時にアイコンの URL を指定したときだけ設定する（失敗しても画面は出す）
  if (APP_ICON_URL_) {
    try {
      output = output.setFaviconUrl(APP_ICON_URL_);
    } catch (err) {
      console.error('setFaviconUrl に失敗: ' + err);
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
