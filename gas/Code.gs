// 配信専用。音声処理はすべてブラウザ側で行い、GAS は HTML を返すだけ（サーバー側の業務ロジックなし）。
//
// 次の 2 行は scripts/bundle-gas.mjs が dist/Code.gs でのみ差し替える（deploy.ps1 の -IconUrl / -RedirectUrl）。
// このソース（gas/Code.gs）自体は書き換わらない。行の形を変えるとビルドが止まるので、そのまま残すこと。
// タブのアイコン（favicon）の URL。https のみ。空なら Apps Script 既定のアイコンのまま。
// GAS は URL 末尾の拡張子（png / ico / jpg / gif）を検査するため、bundle-gas.mjs が末尾に '#.png' などを足す。
var APP_ICON_URL_ = '';
// 旧デプロイから開かれたときの移動先（新しいデプロイの URL）。空なら移動しない。
// スクリプト プロパティ AUDIO_SPLITTER_REDIRECT_URL が設定されていればそちらが優先される（Redirect.gs 参照）。
var REDIRECT_URL_ = '';

function doGet(e) {
  // 旧デプロイ → 新デプロイへのリダイレクト。移動するなら案内ページの HtmlOutput、しなければ null
  var moved = redirectResponse_(e);
  if (moved) return moved;

  // 注意: createHtmlOutput(文字列) で HTML を作り直さないこと。
  // 約 2MB のインラインスクリプトを GAS のパーサが誤認して壊すため、必ず createHtmlOutputFromFile を使う。
  // （createHtmlOutputFromFile はテンプレート評価をしないので、HTML 内の「<?」も評価されない）
  var output = HtmlService.createHtmlOutputFromFile('Index')
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
