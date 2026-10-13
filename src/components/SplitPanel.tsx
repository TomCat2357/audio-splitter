import { useId } from 'react';
import { formatBytes, formatTime } from '../lib/plan';
import { type SegmentRow, type SplitMode, type SplitValues } from '../lib/split';
import { TimeInput } from './TimeInput';

const MODES: { id: SplitMode; label: string }[] = [
  { id: 'manual', label: '手動' },
  { id: 'interval', label: '時間ごと' },
  { id: 'count', label: '等分' },
  { id: 'maxSize', label: 'サイズ上限' },
  { id: 'none', label: '分割しない' },
];

interface Props {
  mode: SplitMode;
  onMode: (m: SplitMode) => void;
  values: SplitValues;
  onValues: (v: SplitValues) => void;
  error: string | null;
  points: number[];
  rows: SegmentRow[];
  locked: boolean;
  onAdjustManually: () => void;
  onCommitPoint: (index: number, sec: number) => boolean;
  onRemovePoint: (index: number) => void;
  onClearPoints: () => void;
  onSeek: (sec: number) => void;
  onSeekAndPlay: (sec: number) => void;
}

function NumberField(props: {
  label: string;
  unit: string;
  value: string;
  step: number;
  min: number;
  testId: string;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={props.min}
        step={props.step}
        value={props.value}
        data-testid={props.testId}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <span className="unit">{props.unit}</span>
    </div>
  );
}

export function SplitPanel(p: Props) {
  const auto = p.mode === 'interval' || p.mode === 'count' || p.mode === 'maxSize';
  const set = (patch: Partial<SplitValues>) => p.onValues({ ...p.values, ...patch });

  return (
    <section className="card" aria-labelledby="split-h">
      <h2 id="split-h">分割の設定</h2>
      <fieldset className="plain" disabled={p.locked}>
        <div className="modes" role="radiogroup" aria-label="分割のしかた">
          {MODES.map((m) => (
            <label key={m.id} className={`mode${p.mode === m.id ? ' is-on' : ''}`}>
              <input
                type="radio"
                name="split-mode"
                value={m.id}
                checked={p.mode === m.id}
                onChange={() => p.onMode(m.id)}
                data-testid={`mode-${m.id}`}
              />
              <span>{m.label}</span>
            </label>
          ))}
        </div>

        <div className="mode-body">
          {p.mode === 'interval' && (
            <NumberField
              label="何分ごとに分けるか"
              unit="分ごと"
              value={p.values.intervalMin}
              min={0}
              step={0.5}
              testId="input-interval"
              onChange={(v) => set({ intervalMin: v })}
            />
          )}
          {p.mode === 'count' && (
            <NumberField
              label="いくつに等分するか"
              unit="個"
              value={p.values.count}
              min={1}
              step={1}
              testId="input-count"
              onChange={(v) => set({ count: v })}
            />
          )}
          {p.mode === 'maxSize' && (
            <>
              <NumberField
                label="1 ファイルの上限"
                unit="MB 以下"
                value={p.values.maxMB}
                min={0}
                step={1}
                testId="input-maxsize"
                onChange={(v) => set({ maxMB: v })}
              />
              <p className="hint">
                実行時に、各ファイルが必ずこのサイズ以下になるよう自動で調整します（表示は目安です）。
              </p>
            </>
          )}
          {p.mode === 'none' && <p className="hint">分割せず、全体を 1 つのファイルとして書き出します。</p>}
          {p.error && (
            <p className="msg msg-error" role="alert" data-testid="settings-error">
              {p.error}
            </p>
          )}

          {auto && !p.error && (
            <div className="preview-note">
              <p className="hint">
                タイムラインの線はプレビューです。位置を細かく直したいときは手動に切り替えます（いまの分割点を引き継ぎます）。
              </p>
              <button type="button" className="btn btn-sm" onClick={p.onAdjustManually} data-testid="adjust-manual-button">
                この位置を手動で調整する
              </button>
            </div>
          )}

          {p.mode === 'manual' && (
            <div className="manual" data-testid="manual-list">
              {p.points.length === 0 ? (
                <p className="hint">
                  分割点はまだありません。再生しながら「現在位置で分割」を押して追加してください。
                </p>
              ) : (
                <ul className="point-list">
                  {p.points.map((pt, i) => (
                    <li key={i} className="point-row" data-testid="point-row">
                      <span className="point-no">分割点 {i + 1}</span>
                      <TimeInput
                        value={pt}
                        label={`分割点 ${i + 1} の時刻`}
                        testId="point-time-input"
                        onCommit={(sec) => p.onCommitPoint(i, sec)}
                      />
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => p.onSeekAndPlay(pt)}
                        aria-label={`分割点 ${i + 1} から再生`}
                        data-testid="point-play"
                      >
                        ここから再生
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => p.onRemovePoint(i)}
                        aria-label={`分割点 ${i + 1} を削除`}
                        data-testid="point-delete"
                      >
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {p.points.length > 0 && (
                <button type="button" className="btn btn-sm btn-danger" onClick={p.onClearPoints} data-testid="clear-points">
                  すべて削除
                </button>
              )}
            </div>
          )}
        </div>
      </fieldset>

      <h3>
        できあがるファイル（{p.rows.length} 個）
      </h3>
      <ol className="seg-list" data-testid="segment-list">
        {p.rows.map((r) => (
          <li key={r.index}>
            <button
              type="button"
              className={`seg-row seg-row-${r.index % 2 === 0 ? 'a' : 'b'}`}
              onClick={() => p.onSeek(r.start)}
              aria-label={`${r.index + 1} 個目の先頭へ移動`}
              data-testid="segment-row"
            >
              <span className="seg-no">{r.index + 1}</span>
              <span className="seg-range">
                {formatTime(r.start)} 〜 {formatTime(r.end)}
              </span>
              <span className="seg-len">長さ {formatTime(r.end - r.start)}</span>
              <span className="seg-size">約 {formatBytes(r.bytes)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
