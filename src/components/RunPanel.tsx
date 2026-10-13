import { useStoreValue } from '../hooks/useStoreValue';
import type { Store } from '../lib/store';
import type { JobProgress } from '../lib/types';

export type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; count: number }
  | { status: 'aborted'; count: number }
  | { status: 'error'; message: string; count: number };

function ProgressView({ store, exact }: { store: Store<JobProgress | null>; exact: boolean }) {
  const p = useStoreValue(store);
  const percent = p ? Math.round(p.overall * 100) : 0;
  const n = p ? Math.min(p.partIndex + 1, Math.max(p.estimatedParts, p.partIndex + 1)) : 1;
  const text = !p
    ? '準備中…'
    : exact
      ? `${n} / ${p.estimatedParts} 個目を処理中（${percent}%）`
      : `${n} 個目を処理中（全体の ${percent}%）`;
  return (
    <div className="progress-wrap">
      <div
        className="progress"
        role="progressbar"
        aria-label="書き出しの進み具合"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        data-testid="progress"
      >
        <div className="progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <p className="progress-text" aria-live="polite" data-testid="progress-text">
        {text}
      </p>
    </div>
  );
}

interface Props {
  label: string;
  disabled: boolean;
  disabledReason: string | null;
  state: RunState;
  progress: Store<JobProgress | null>;
  exactCount: boolean;
  onRun: () => void;
  onCancel: () => void;
}

export function RunPanel({ label, disabled, disabledReason, state, progress, exactCount, onRun, onCancel }: Props) {
  const running = state.status === 'running';
  return (
    <section className="card" aria-labelledby="run-h">
      <h2 id="run-h">書き出し</h2>
      {running ? (
        <div className="run-row">
          <ProgressView store={progress} exact={exactCount} />
          <button type="button" className="btn btn-danger" onClick={onCancel} data-testid="cancel-button">
            中止
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="btn btn-primary btn-run"
            onClick={onRun}
            disabled={disabled}
            data-testid="run-button"
          >
            {label}
          </button>
          {disabled && disabledReason && <p className="hint">{disabledReason}</p>}
        </>
      )}
      <div aria-live="polite" data-testid="run-message">
        {state.status === 'done' && (
          <p className="msg msg-ok">できあがりました（{state.count} 個）。下から保存できます。</p>
        )}
        {state.status === 'aborted' && (
          <p className="msg msg-warn">
            途中で中止しました。できあがった {state.count} 個分は下に残っています。
          </p>
        )}
        {state.status === 'error' && (
          <p className="msg msg-error" role="alert">
            {state.message}
            {state.count > 0 && ` （それまでにできあがった ${state.count} 個分は下に残っています）`}
          </p>
        )}
      </div>
    </section>
  );
}
