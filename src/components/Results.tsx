import { formatBytes, formatTime } from '../lib/plan';
import type { OutputPart } from '../lib/types';

export interface ResultItem {
  part: OutputPart;
  url: string;
}

interface Props {
  items: ResultItem[];
  zipping: boolean;
  zipError: string | null;
  onZip: () => void;
}

export function Results({ items, zipping, zipError, onZip }: Props) {
  if (items.length === 0) return null;
  const total = items.reduce((s, r) => s + r.part.blob.size, 0);
  return (
    <section className="card" aria-labelledby="res-h" data-testid="results">
      <h2 id="res-h">できあがったファイル</h2>
      <div className="results-head">
        <p className="results-total" data-testid="results-total">
          {items.length} 個・合計 {formatBytes(total)}
        </p>
        <button type="button" className="btn btn-primary" onClick={onZip} disabled={zipping} data-testid="zip-button">
          {zipping ? 'ZIP を作成中…' : 'すべて ZIP で保存'}
        </button>
      </div>
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
