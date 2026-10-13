import { formatBytes } from '../lib/plan';
import type { AudioInfo, EncodeFormat } from '../lib/types';

export interface OutputState {
  kind: 'copy' | 'encode';
  format: EncodeFormat;
  bitrateKbps: number;
  mono: boolean;
}

export const BITRATES = [32, 48, 64, 96, 128, 192];

interface Props {
  info: AudioInfo;
  value: OutputState;
  onChange: (v: OutputState) => void;
  locked: boolean;
  totalBytes: number;
}

export function OutputSettings({ info, value, onChange, locked, totalBytes }: Props) {
  const set = (patch: Partial<OutputState>) => onChange({ ...value, ...patch });
  const copyOk = info.copyFormat !== null;
  const encodeOk = info.canDecode;
  const encoding = value.kind === 'encode';
  const ratio = info.fileSize > 0 ? Math.round((totalBytes / info.fileSize) * 100) : 0;

  return (
    <section className="card" aria-labelledby="out-h">
      <h2 id="out-h">出力の設定</h2>
      <fieldset className="plain" disabled={locked}>
        <div className="radio-cards" role="radiogroup" aria-label="出力のしかた">
          <label className={`radio-card${value.kind === 'copy' ? ' is-on' : ''}${copyOk ? '' : ' is-disabled'}`}>
            <input
              type="radio"
              name="out-kind"
              checked={value.kind === 'copy'}
              disabled={!copyOk}
              onChange={() => set({ kind: 'copy' })}
              data-testid="output-copy"
            />
            <span>
              <strong>元の音質のまま（無劣化・高速）</strong>
              <span className="sub">
                {copyOk
                  ? `出力形式: ${info.copyFormat!.label}`
                  : 'この音声は元の形式のままでは書き出せません。圧縮を選んでください。'}
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
              <strong>圧縮する（再エンコード）</strong>
              <span className="sub">
                {encodeOk
                  ? 'ビットレートを下げて、ファイルを小さくします。時間がかかります。'
                  : 'このブラウザではこの音声を読み取れないため圧縮できません。Chrome か Edge で開いてください。'}
              </span>
            </span>
          </label>
        </div>

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
                <option value="m4a">M4A（AAC）</option>
                <option value="mp3">MP3</option>
              </select>
            </div>
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
            <label className="check">
              <input
                type="checkbox"
                checked={value.mono}
                onChange={(e) => set({ mono: e.target.checked })}
                data-testid="mono-checkbox"
              />
              <span>
                モノラルにする
                <span className="sub">会議や音声メモ向け。同じ容量で、声が聞き取りやすくなります</span>
              </span>
            </label>
          </div>
        )}
      </fieldset>

      <p className="estimate" aria-live="polite" data-testid="output-estimate">
        出力合計の目安: <strong>約 {formatBytes(totalBytes)}</strong>（元の {ratio}%）
      </p>
    </section>
  );
}
