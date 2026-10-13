import { folderUrl } from '../lib/drivePlaces';
import { formatBytes, formatTime } from '../lib/plan';
import type { OutputPart } from '../lib/types';

export interface ResultItem {
  part: OutputPart;
  url: string;
}

/** Google ドライブへの保存の状態 */
export type SaveState =
  | { status: 'idle' }
  | { status: 'saving'; index: number; total: number; percent: number; folderName: string }
  | { status: 'done'; count: number; folder: { id: string; name: string }; namesIncomplete?: boolean }
  | {
      status: 'stopped';
      reason: 'aborted' | 'error';
      message?: string;
      saved: number;
      total: number;
      folder: { id: string; name: string };
      /** 保存先の一覧が打ち切られ、同名のファイルがあるかを確認しきれなかった */
      namesIncomplete?: boolean;
    };

export interface DriveSaveProps {
  state: SaveState;
  /** 分割の実行中などで保存できないとき true */
  disabled: boolean;
  onSave: () => void;
  onCancel: () => void;
}

interface Props {
  items: ResultItem[];
  zipping: boolean;
  zipError: string | null;
  onZip: () => void;
  /** Drive が使えるときだけ渡す（null なら Drive 関連は何も表示しない） */
  drive?: DriveSaveProps | null;
}

function FolderLink({ folder }: { folder: { id: string; name: string } }) {
  // GAS の iframe の中なので、別タブで開く
  return (
    <a href={folderUrl(folder.id)} target="_blank" rel="noopener noreferrer" data-testid="drive-save-link">
      ドライブで「{folder.name}」を開く
    </a>
  );
}

/** 保存先の項目が多く、同名の確認が不完全だったときの注意（保存は続けている。最悪でも同名のファイルが 2 つできるだけ） */
function NamesIncompleteNote() {
  return (
    <p className="msg msg-warn" data-testid="drive-save-truncated-note">
      保存先の項目が多いため、同じ名前のファイルがあるかを確認しきれませんでした。同じ名前のファイルが 2 つできている場合は、Google ドライブで確認してください。
    </p>
  );
}

function DriveSaveStatus({ drive }: { drive: DriveSaveProps }) {
  const s = drive.state;
  if (s.status === 'saving') {
    const text = `${Math.min(s.index + 1, s.total)} / ${s.total} 個目を保存中（全体の ${s.percent}%）`;
    return (
      <div className="drive-save-progress" data-testid="drive-save-progress">
        <div className="progress-wrap">
          <div
            className="progress"
            role="progressbar"
            aria-label="Google ドライブへの保存の進み具合"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={s.percent}
            aria-valuetext={text}
          >
            <div className="progress-bar" style={{ width: `${s.percent}%` }} />
          </div>
          <p className="progress-text" role="status" data-testid="drive-save-text">
            {text}
          </p>
          <p className="hint">保存先: {s.folderName}</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={drive.onCancel} data-testid="drive-save-cancel">
          中止
        </button>
      </div>
    );
  }
  if (s.status === 'done') {
    return (
      <>
        <p className="msg msg-ok" role="status" data-testid="drive-save-done">
          Google ドライブの「{s.folder.name}」に {s.count} 個を保存しました。 <FolderLink folder={s.folder} />
        </p>
        {s.namesIncomplete && <NamesIncompleteNote />}
      </>
    );
  }
  if (s.status === 'stopped') {
    const head =
      s.reason === 'aborted'
        ? `保存を中止しました。${s.total} 個のうち ${s.saved} 個を保存しました。`
        : `保存に失敗しました。${s.total} 個のうち ${s.saved} 個を保存したところで止まりました。${s.message ?? ''}`;
    return (
      <>
        <p
          className={`msg ${s.reason === 'aborted' ? 'msg-warn' : 'msg-error'}`}
          role="alert"
          data-testid="drive-save-stopped"
        >
          {head}
          {s.saved > 0 && (
            <>
              {' '}
              保存できた分は「{s.folder.name}」にあります。 <FolderLink folder={s.folder} />
            </>
          )}
        </p>
        {s.namesIncomplete && <NamesIncompleteNote />}
      </>
    );
  }
  return null;
}

export function Results({ items, zipping, zipError, onZip, drive }: Props) {
  if (items.length === 0) return null;
  const total = items.reduce((s, r) => s + r.part.blob.size, 0);
  return (
    <section className="card" aria-labelledby="res-h" data-testid="results">
      <h2 id="res-h">できあがったファイル</h2>
      <div className="results-head">
        <p className="results-total" data-testid="results-total">
          {items.length} 個・合計 {formatBytes(total)}
        </p>
        <div className="results-actions">
          <button type="button" className="btn btn-primary" onClick={onZip} disabled={zipping} data-testid="zip-button">
            {zipping ? 'ZIP を作成中…' : 'すべて ZIP で保存'}
          </button>
          {drive && (
            <button
              type="button"
              className="btn"
              onClick={drive.onSave}
              disabled={drive.disabled || drive.state.status === 'saving'}
              data-testid="drive-save-button"
            >
              {drive.state.status === 'done' ? 'もう一度 Google ドライブに保存' : 'Google ドライブに保存'}
            </button>
          )}
        </div>
      </div>
      {drive && <DriveSaveStatus drive={drive} />}
      {zipping && (
        <p className="msg msg-info" role="status" data-testid="zip-status">
          ZIP を作成しています。しばらくお待ちください。
        </p>
      )}
      {zipError && (
        <p className="msg msg-error" role="alert">
          {zipError}
        </p>
      )}
      <ul className="result-list">
        {items.map(({ part, url }) => (
          <li key={part.index} className="result-row" data-testid="result-row">
            <div className="result-info">
              <p className="result-name" data-testid="result-name">
                {part.fileName}
              </p>
              <p className="result-meta">
                長さ {formatTime(part.durationSec)}（元の {formatTime(part.startSec)} 〜 {formatTime(part.endSec)}）・
                {formatBytes(part.blob.size)}
              </p>
            </div>
            <audio controls preload="none" src={url} aria-label={`${part.fileName} の試し聴き`} />
            <a className="btn btn-sm" href={url} download={part.fileName} data-testid="result-save">
              保存
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
