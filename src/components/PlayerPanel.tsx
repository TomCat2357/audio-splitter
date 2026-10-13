import { useStoreValue } from '../hooks/useStoreValue';
import type { Player } from '../hooks/usePlayer';
import { formatTime } from '../lib/plan';
import { Timeline } from './Timeline';

const RATES = [0.75, 1, 1.25, 1.5, 2];
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
        <label className="rate">
          <span>再生速度</span>
          <select
            value={player.rate}
            onChange={(e) => player.setRate(Number(e.target.value))}
            data-testid="rate-select"
            disabled={player.unplayable}
          >
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r} 倍
              </option>
            ))}
          </select>
        </label>
      </div>

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
          ショートカット: <kbd>Space</kbd> 再生/一時停止、<kbd>S</kbd> 現在位置で分割。マーカーは左右キーで動かし、Delete で削除できます。
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
