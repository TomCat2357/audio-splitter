// GAS の HtmlService は BMP 外の文字（絵文字などのサロゲートペア）を配信時に壊すことがある。
// 最終チャンクの非 ASCII 文字を UTF-16 コード単位ごとに「バックスラッシュ + u + 4 桁 16 進」へ置換する。
// コード単位ごとの置換なので、文字列・テンプレートリテラル・正規表現リテラル・識別子の
// どこに現れても JS として等価なまま完全 ASCII になる（コメント内に出ても無害）。
//
// vite-plugin-singlefile が chunk.code を HTML へインライン化する前に書き換える必要があるため、
// enforce: 'post' とし、plugins 配列では viteSingleFile より前に置くこと。
// （Rolldown では renderChunk の戻り値が singlefile の読む chunk.code に反映されないので、
//   generateBundle で chunk.code を直接書き換える。）

const BACKSLASH = String.fromCharCode(92);

export const escapeNonAscii = (code) =>
  code.replace(/[^\x00-\x7f]/g, (c) => BACKSLASH + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function asciiEscape() {
  return {
    name: 'audio-splitter:ascii-escape',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk && chunk.type === 'chunk' && typeof chunk.code === 'string') {
          chunk.code = escapeNonAscii(chunk.code);
        }
      }
    },
  };
}
