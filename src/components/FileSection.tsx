import { useRef } from 'react';
import { formatBytes, formatTime } from '../lib/plan';
import type { AudioInfo } from '../lib/types';

export const ACCEPT =
  'audio/*,.m4a,.mp3,.wav,.ogg,.oga,.opus,.flac,.aac,video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv';

export type ProbeState = { status: 'idle' } | { status: 'probing' } | { status: 'error'; message: string };

/** Google ドライブからのダウンロードの状態 */
export type DownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; name: string; loaded: number; total: number }
  | { status: 'error'; name: string; message: string }
  | { status: 'aborted'; name: string };

export interface DriveFileProps {
  download: DownloadState;
  onOpen: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

interface Props {
  info: AudioInfo | null;
  probe: ProbeState;
  fileName: string | null;
  locked: boolean;
  onFile: (file: File) => void;
  /** Drive が使えるときだけ渡す（null なら Drive 関連は何も表示しない） */
  drive?: DriveFileProps | null;
}

function channelsLabel(n: number): string {
  if (n === 1) return 'モノラル';
  if (n === 2) return 'ステレオ';
  return `${n} ch`;
}

function InfoCard({ info }: { info: AudioInfo }) {
  const rows: [string, string][] = [
    ['長さ', formatTime(info.durationSec)],
    ['サイズ', formatBytes(info.fileSize)],
    ['形式', `${info.containerLabel}（${info.codec}）`],
    ['サンプルレート', `${Number((info.sampleRate / 1000).toFixed(2))} kHz`],
    ['チャンネル', channelsLabel(info.numberOfChannels)],
    ['ビットレート', `約 ${Math.round(info.audioBitrate / 1000)} kbps`],
  ];
  return (
    <div className="info-card" data-testid="info-card">
      <p className="info-name" data-testid="info-name">
        {info.fileName}
      </p>
      <dl className="info-grid">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {info.hasVideo && <p className="hint">映像が入っているファイルです。音声だけを取り出します。</p>}
    </div>
  );
}

function DownloadStatus({ drive }: { drive: DriveFileProps }) {
  const d = drive.download;
  if (d.status === 'downloading') {
    const percent = d.total > 0 ? Math.min(100, Math.round((d.loaded / d.total) * 100)) : 0;
    const text =
      d.total > 0
        ? `ダウンロード中… ${formatBytes(d.loaded)} / ${formatBytes(d.total)}（${percent}%）`
        : 'ダウンロードを準備しています…';
    return (
      <div className="drive-download" data-testid="drive-download">
        <p className="info-name">{d.name}</p>
        <div className="progress-wrap">
          <div
            className="progress"
            role="progressbar"
            aria-label="ダウンロードの進み具合"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={text}
            data-testid="drive-download-progress"
          >
            <div className="progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <p className="progress-text" role="status" data-testid="drive-download-text">
            {text}
          </p>
        </div>
        <p className="hint">大きなファイルは時間がかかります。このページを開いたままお待ちください。</p>
        <button type="button" className="btn btn-danger" onClick={drive.onCancel} data-testid="drive-download-cancel">
          中止
        </button>
      </div>
    );
  }
  if (d.status === 'error') {
    return (
      <div className="msg msg-error drive-download-error" role="alert" data-testid="drive-download-error">
        <p>
          「{d.name}」を開けませんでした。{d.message}
        </p>
        <button type="button" className="btn btn-sm" onClick={drive.onRetry} data-testid="drive-download-retry">
          もう一度試す
        </button>
      </div>
    );
  }
  if (d.status === 'aborted') {
    return (
      <p className="msg msg-warn" role="status" data-testid="drive-download-aborted">
        ダウンロードを中止しました。
      </p>
    );
  }
  return null;
}

export function FileSection({ info, probe, fileName, locked, onFile, drive }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = () => inputRef.current?.click();
  const downloading = drive?.download.status === 'downloading';
  const disabled = locked || downloading;

  return (
    <section className="card" aria-labelledby="file-h">
      <h2 id="file-h">ファイルを読み込む</h2>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        data-testid="file-input"
        aria-label="音声ファイルを選ぶ"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />

      {probe.status === 'probing' && (
        <p className="msg msg-info" role="status" data-testid="probe-status">
          解析中… {fileName}
        </p>
      )}

      {probe.status === 'error' && (
        <p className="msg msg-error" role="alert" data-testid="file-error">
          {probe.message}
        </p>
      )}

      {drive && <DownloadStatus drive={drive} />}

      {info && probe.status === 'idle' ? (
        <div className="file-loaded">
          <InfoCard info={info} />
          <div className="file-actions">
            <button type="button" className="btn" onClick={open} disabled={disabled} data-testid="change-file-button">
              別のファイルを選ぶ
            </button>
            {drive && (
              <button
                type="button"
                className="btn"
                onClick={drive.onOpen}
                disabled={disabled}
                data-testid="drive-change-button"
              >
                ドライブから別のファイルを選ぶ
              </button>
            )}
          </div>
        </div>
      ) : (
        probe.status !== 'probing' &&
        !downloading && (
          <div className="dropzone" data-testid="drop-zone">
            <p className="dropzone-title">ここに音声ファイルをドラッグ＆ドロップ</p>
            <p className="hint">m4a / mp3 / wav / ogg / flac や、音声入りの mp4 などの動画が使えます。</p>
            <div className="dropzone-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={open}
                disabled={disabled}
                data-testid="choose-file-button"
              >
                ファイルを選ぶ
              </button>
              {drive && (
                <button
                  type="button"
                  className="btn"
                  onClick={drive.onOpen}
                  disabled={disabled}
                  data-testid="drive-choose-button"
                >
                  Google ドライブから選ぶ
                </button>
              )}
            </div>
          </div>
        )
      )}
    </section>
  );
}
