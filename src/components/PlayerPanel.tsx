import { useState } from 'react';
import { useStoreValue } from '../hooks/useStoreValue';
import type { Player } from '../hooks/usePlayer';
import { formatTime } from '../lib/plan';
import { MAX_PITCH, MIN_PITCH, PITCH_STEP, formatPitch } from '../lib/pitch';
import { MAX_RATE, MIN_RATE, RATE_PRESETS, RATE_STEP, formatRate } from '../lib/rate';
import { Timeline } from './Timeline';

const SKIPS = [
  { delta: -10, label: '−10 秒', aria: '10 秒戻る', id: 'back10' },
  { delta: -1, label: '−1 秒', aria: '1 秒戻る', id: 'back1' },
  { delta: 1, label: '+1 秒', aria: '1 秒進む', id: 'fwd1' },
  { delta: 10, label: '+10 秒', aria: '10 秒進む', id: 'fwd10' },
];

function CurrentTime({ player }: { player: Player }) {
  const t = useStoreValue(player.timeStore, (v) => formatTime(v, { fraction: true }));
  return <span data-testid="current-time">{t}</span>;
}

/** 倍率の数値入力。入力中は下書きのままにして、確定（Enter / フォーカスを外す）したときに範囲へ丸める */
function RateInput({ player }: { player: Player }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n)) player.setRate(n);
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className="rate-num"
      aria-label="再生速度（倍）"
      value={draft ?? formatRate(player.rate)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') setDraft(null);
      }}
      disabled={player.unplayable}
      data-testid="rate-input"
    />
  );
}

interface Props {
  player: Player;
  duration: number;
  points: number[];
  editable: boolean;
  locked: boolean;
  notice: { text: string; tone: 'info' | 'warn' } | null;
  onSplitHere: () => void;
  onMovePoint: (index: number, sec: number) => void;
  onRemovePoint: (index: number) => void;
}

export function PlayerPanel({
  player,
  duration,
  points,
  editable,
  locked,
  notice,
  onSplitHere,
  onMovePoint,
  onRemovePoint,
}: Props) {
  return (
    <section className="card" aria-labelledby="player-h">
      <h2 id="player-h">再生して分割位置を決める</h2>
      <audio {...player.audioProps} hidden />

      {player.unplayable && (
        <p className="msg msg-warn" role="status" data-testid="unplayable-message">
          このブラウザでは再生できませんが、分割・圧縮は実行できます。タイムラインをクリックするか、時刻を入力して分割位置を決めてください。
        </p>
      )}

      <div className="transport">
        <button
          type="button"
          className="btn btn-play"
          onClick={player.toggle}
          disabled={player.unplayable}
          aria-label={player.playing ? '一時停止' : '再生'}
          data-testid="play-button"
        >
          {player.playing ? (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
            </svg>
          )}
        </button>
        <div className="clock" aria-label="現在の位置と全体の長さ" data-testid="time-display">
          <CurrentTime player={player} /> <span className="clock-sep">/</span> {formatTime(duration)}
        </div>
        <div className="skips">
          {SKIPS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="btn btn-sm"
              aria-label={s.aria}
              data-testid={`skip-${s.id}`}
              onClick={() => player.skip(s.delta)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn-sm btn-reverse${player.reverse ? ' is-on' : ''}`}
          aria-pressed={player.reverse}
          onClick={() => player.setReverse(!player.reverse)}
          disabled={!player.canProcess}
          title={player.canProcess ? '逆向きに再生します' : 'このファイルは逆再生できません'}
          data-testid="reverse-toggle"
        >
          <span aria-hidden="true">◀ </span>逆再生
        </button>
      </div>

      <div className="speed-row">
        <label className="rate">
          <span>再生速度</span>
          <input
            type="range"
            min={MIN_RATE}
            max={MAX_RATE}
            step={RATE_STEP}
            value={player.rate}
            onChange={(e) => player.setRate(Number(e.target.value))}
            disabled={player.unplayable}
            aria-valuetext={`${formatRate(player.rate)} 倍`}
            data-testid="rate-slider"
          />
        </label>
        <span className="rate-value">
          <RateInput player={player} /> 倍
        </span>
        <div className="rate-presets" role="group" aria-label="よく使う速度">
          {RATE_PRESETS.map((r) => (
            <button
              key={r}
              type="button"
              className="btn btn-sm"
              aria-pressed={player.rate === r}
              onClick={() => player.setRate(r)}
              disabled={player.unplayable}
              data-testid={`rate-preset-${r}`}
            >
              {r}
            </button>
          ))}
        </div>
        <label className="check keep-pitch">
          <input
            type="checkbox"
            checked={player.keepPitch}
            onChange={(e) => player.setKeepPitch(e.target.checked)}
            disabled={player.unplayable}
            data-testid="keep-pitch"
          />
          <span>
            音程を保つ
            <span className="sub">
              {player.keepPitch
                ? '速さを変えても声の高さは変わりません'
                : 'テープのように、速くすると高く、遅くすると低くなります'}
            </span>
          </span>
        </label>
      </div>

      <div className="speed-row pitch-row">
        <label className="rate">
          <span>音程</span>
          <input
            type="range"
            min={MIN_PITCH}
            max={MAX_PITCH}
            step={PITCH_STEP}
            value={player.pitch}
            onChange={(e) => player.setPitch(Number(e.target.value))}
            disabled={!player.canProcess}
            aria-valuetext={`${formatPitch(player.pitch)} 半音`}
            data-testid="pitch-slider"
          />
        </label>
        <span className="rate-value" data-testid="pitch-value">
          {formatPitch(player.pitch)} 半音
        </span>
        <div className="rate-presets" role="group" aria-label="音程の調整">
          <button
            type="button"
            className="btn btn-sm"
            aria-label="半音下げる"
            onClick={() => player.stepPitch(-1)}
            disabled={!player.canProcess || player.pitch <= MIN_PITCH}
            data-testid="pitch-down"
          >
            ♭
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="半音上げる"
            onClick={() => player.stepPitch(1)}
            disabled={!player.canProcess || player.pitch >= MAX_PITCH}
            data-testid="pitch-up"
          >
            ♯
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => player.setPitch(0)}
            disabled={!player.canProcess || player.pitch === 0}
            data-testid="pitch-reset"
          >
            元の音程
          </button>
        </div>
        {!player.canProcess && !player.unplayable && (
          <span className="sub" data-testid="pitch-unavailable">
            このファイルは音程を変えられません
          </span>
        )}
      </div>
      {player.playError && (
        <p className="msg msg-warn" role="status" data-testid="play-error">
          {player.playError}
        </p>
      )}

      <Timeline
        duration={duration}
        points={points}
        editable={editable}
        timeStore={player.timeStore}
        seek={player.seek}
        onMovePoint={onMovePoint}
        onRemovePoint={onRemovePoint}
      />

      <div className="split-row">
        <button
          type="button"
          className="btn btn-primary btn-split"
          onClick={onSplitHere}
          disabled={locked}
          data-testid="split-here"
        >
          現在位置で分割
          <kbd aria-hidden="true">S</kbd>
        </button>
        <p className="hint">
          ショートカット: <kbd>Space</kbd> 再生/一時停止、<kbd>S</kbd> 現在位置で分割、<kbd>[</kbd> <kbd>]</kbd> 再生速度を 0.25 ずつ下げる/上げる、<kbd>\</kbd> または <kbd>=</kbd> で 1 倍に戻す。マーカーは左右キーで動かし、Delete で削除できます。
        </p>
      </div>
      <p
        className={`msg ${notice ? (notice.tone === 'warn' ? 'msg-warn' : 'msg-info') : 'msg-empty'}`}
        role="status"
        aria-live="polite"
        data-testid="split-notice"
      >
        {notice?.text}
      </p>
    </section>
  );
}
