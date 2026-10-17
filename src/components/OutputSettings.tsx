import { formatBytes, isPcmFormat } from '../lib/plan';
import { formatPitch } from '../lib/pitch';
import { formatRate } from '../lib/rate';
import type { AudioInfo, EncodeFormat } from '../lib/types';

export interface OutputState {
  kind: 'copy' | 'encode';
  format: EncodeFormat;
  bitrateKbps: number;
  mono: boolean;
  /** Hz。0 = 元のまま。WAV / FLAC のときだけ効く */
  sampleRate: number;
  /** 現在の再生速度・音程で書き出す（既定オフ）。速度 1 倍・音程 0 のときは効かない */
  atPlayback: boolean;
}

/** いまの再生の設定（速度・音程） */
export interface PlaybackSettings {
  rate: number;
  /** 半音 */
  pitch: number;
  keepPitch: boolean;
}

/** 再生速度・音程を反映して書き出すか。反映するときは無劣化コピーが使えず、再エンコードになる */
export function isPlaybackExportActive(value: OutputState, playback: PlaybackSettings, info: AudioInfo): boolean {
  return value.atPlayback && (playback.rate !== 1 || playback.pitch !== 0) && info.canDecode;
}

/** 「×1.5・音程 +3 半音」のような、いまの再生の設定の短い表記 */
function playbackSummary({ rate, pitch, keepPitch }: PlaybackSettings): string {
  const parts = [`×${formatRate(rate)}`];
  if (rate !== 1 && !keepPitch) parts.push('音程も速さに合わせて変える');
  if (pitch !== 0) parts.push(`音程 ${formatPitch(pitch)} 半音`);
  return parts.join('・');
}

/** 反映して書き出すときに、何がどう変わるかの説明 */
function playbackEffect({ rate, pitch, keepPitch }: PlaybackSettings): string {
  const length = rate !== 1 ? `長さが 1/${formatRate(rate)} になります` : '長さは変わりません';
  let tone: string;
  if (rate !== 1 && !keepPitch) tone = pitch !== 0 ? `音程は速さに合わせて変わり、さらに ${formatPitch(pitch)} 半音ずれます` : '音程も速さに合わせて変わります';
  else tone = pitch !== 0 ? `音程が ${formatPitch(pitch)} 半音変わります` : '音程は変わりません';
  return `${length}。${tone}。`;
}

export const BITRATES = [32, 48, 64, 96, 128, 192];

export const SAMPLE_RATES = [
  { hz: 0, label: '元のまま' },
  { hz: 48000, label: '48 kHz' },
  { hz: 44100, label: '44.1 kHz' },
  { hz: 22050, label: '22.05 kHz' },
  { hz: 16000, label: '16 kHz（音声認識向け）' },
];

const FORMAT_NOTES: Record<EncodeFormat, string> = {
  m4a: '多くの機器で再生できる、標準的な形式です。',
  mp3: 'ほとんどのソフトや機器で使える、定番の形式です。',
  ogg: '同じ大きさなら MP3 より音が良い新しい形式です。対応していないソフトもあります。',
  wav: 'ほとんどのソフトで開けます。ファイルは大きくなります。音質は 16bit になります（24bit の音声も 16bit になります）。',
  flac: '音質を落とさずに WAV より小さくなります。対応していないソフトもあります。',
};

interface Props {
  info: AudioInfo;
  value: OutputState;
  onChange: (v: OutputState) => void;
  locked: boolean;
  totalBytes: number;
  /** 形式ごとに書き出せるか。null = 調べている最中 */
  support: Record<EncodeFormat, boolean> | null;
  /** いまの再生の設定（速度・音程） */
  playback: PlaybackSettings;
}

export function OutputSettings({ info, value, onChange, locked, totalBytes, support, playback }: Props) {
  const set = (patch: Partial<OutputState>) => onChange({ ...value, ...patch });
  const copyOk = info.copyFormat !== null;
  const encodeOk = info.canDecode;
  const speedOn = isPlaybackExportActive(value, playback, info);
  // 速度・音程を変えて書き出すときは、選択に関わらず再エンコードになる
  const encoding = value.kind === 'encode' || speedOn;
  const ratio = info.fileSize > 0 ? Math.round((totalBytes / info.fileSize) * 100) : 0;
  const pcm = isPcmFormat(value.format);
  const opusOk = support?.ogg === true;
  const opusLabel = support === null ? 'Opus（確認しています…）' : opusOk ? 'Opus' : 'Opus（このブラウザでは使えません）';

  return (
    <section className="card" aria-labelledby="out-h">
      <h2 id="out-h">出力の設定</h2>
      <fieldset className="plain" disabled={locked}>
        <div className="radio-cards" role="radiogroup" aria-label="出力のしかた">
          <label className={`radio-card${!encoding ? ' is-on' : ''}${copyOk && !speedOn ? '' : ' is-disabled'}`}>
            <input
              type="radio"
              name="out-kind"
              checked={!encoding}
              disabled={!copyOk || speedOn}
              onChange={() => set({ kind: 'copy' })}
              data-testid="output-copy"
            />
            <span>
              <strong>元の音質のまま（無劣化・高速）</strong>
              <span className="sub">
                {speedOn
                  ? '再生速度・音程を変えて書き出すときは使えません（再エンコードになります）。'
                  : copyOk
                    ? `出力形式: ${info.copyFormat!.label}`
                    : 'この音声は元の形式のままでは書き出せません。形式を変換する方を選んでください。'}
              </span>
            </span>
          </label>

          <label className={`radio-card${encoding ? ' is-on' : ''}${encodeOk ? '' : ' is-disabled'}`}>
            <input
              type="radio"
              name="out-kind"
              checked={encoding}
              disabled={!encodeOk}
              onChange={() => set({ kind: 'encode' })}
              data-testid="output-encode"
            />
            <span>
              <strong>形式を変換・圧縮する（再エンコード）</strong>
              <span className="sub">
                {encodeOk
                  ? 'WAV・FLAC・Opus などへの変換や、ファイルを小さくする圧縮ができます。時間がかかります。'
                  : 'このブラウザではこの音声を読み取れないため変換・圧縮できません。Chrome か Edge で開いてください。'}
              </span>
            </span>
          </label>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={value.atPlayback}
            disabled={!encodeOk}
            onChange={(e) => set({ atPlayback: e.target.checked })}
            data-testid="at-speed-checkbox"
          />
          <span>
            現在の再生速度・音程（{playbackSummary(playback)}）で書き出す
            <span className="sub" data-testid="at-speed-note">
              {!encodeOk
                ? 'このブラウザではこの音声を読み取れないため使えません。'
                : speedOn
                  ? '再エンコードで書き出します（元の音質のままのコピーは使えません）。' + playbackEffect(playback)
                  : value.atPlayback
                    ? 'いまは 1 倍・元の音程なので、そのまま書き出されます。速度や音程を変えるとそのとおりになります。'
                    : '再生と同じ速さ・音程で書き出します（逆再生は反映されません）。再エンコードになります。'}
            </span>
          </span>
        </label>

        {encoding && (
          <div className="encode-opts">
            <div className="field">
              <label htmlFor="enc-format">形式</label>
              <select
                id="enc-format"
                value={value.format}
                onChange={(e) => set({ format: e.target.value as EncodeFormat })}
                data-testid="format-select"
              >
                <optgroup label="小さくする">
                  <option value="m4a">M4A（AAC）</option>
                  <option value="mp3">MP3</option>
                  <option value="ogg" disabled={!opusOk}>
                    {opusLabel}
                  </option>
                </optgroup>
                <optgroup label="音質を保つ">
                  <option value="wav">WAV（無圧縮）</option>
                  <option value="flac">FLAC（可逆圧縮）</option>
                </optgroup>
              </select>
            </div>
            <p className="sub format-note" data-testid="format-note">
              {FORMAT_NOTES[value.format]}
            </p>
            {support !== null && !support.ogg && (
              <p className="sub" data-testid="opus-unavailable">
                このブラウザでは Opus を書き出せません（Chrome / Edge / Firefox では使えます）。
              </p>
            )}
            {pcm ? (
              <div className="field">
                <label htmlFor="enc-samplerate">サンプルレート</label>
                <select
                  id="enc-samplerate"
                  value={value.sampleRate}
                  onChange={(e) => set({ sampleRate: Number(e.target.value) })}
                  data-testid="samplerate-select"
                >
                  {SAMPLE_RATES.map((r) => (
                    <option key={r.hz} value={r.hz}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="enc-bitrate">ビットレート</label>
                <select
                  id="enc-bitrate"
                  value={value.bitrateKbps}
                  onChange={(e) => set({ bitrateKbps: Number(e.target.value) })}
                  data-testid="bitrate-select"
                >
                  {BITRATES.map((b) => (
                    <option key={b} value={b}>
                      {b} kbps
                    </option>
                  ))}
                </select>
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={value.mono}
                onChange={(e) => set({ mono: e.target.checked })}
                data-testid="mono-checkbox"
              />
              <span>
                モノラルにする
                <span className="sub">
                  {pcm
                    ? '会議や音声メモ向け。ステレオの音声なら、ファイルが約半分になります'
                    : '会議や音声メモ向け。同じ容量で、声が聞き取りやすくなります'}
                </span>
              </span>
            </label>
          </div>
        )}
      </fieldset>

      <p className="estimate" aria-live="polite" data-testid="output-estimate">
        出力合計の目安: <strong>約 {formatBytes(totalBytes)}</strong>（元の {ratio}%
        {ratio > 100 ? '。元より大きくなります' : ''}）
        {encoding && value.format === 'flac' && (
          <span className="sub">FLAC は内容によって変わります（目安は WAV の約 6 割）</span>
        )}
      </p>
    </section>
  );
}
