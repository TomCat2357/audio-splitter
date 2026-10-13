import { useRef } from 'react';
import { formatBytes, formatTime } from '../lib/plan';
import type { AudioInfo } from '../lib/types';

export const ACCEPT =
  'audio/*,.m4a,.mp3,.wav,.ogg,.oga,.opus,.flac,.aac,video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv';

export type ProbeState = { status: 'idle' } | { status: 'probing' } | { status: 'error'; message: string };

interface Props {
  info: AudioInfo | null;
  probe: ProbeState;
  fileName: string | null;
  locked: boolean;
  onFile: (file: File) => void;
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

export function FileSection({ info, probe, fileName, locked, onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = () => inputRef.current?.click();

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

      {info && probe.status === 'idle' ? (
        <div className="file-loaded">
          <InfoCard info={info} />
          <button type="button" className="btn" onClick={open} disabled={locked} data-testid="change-file-button">
            別のファイルを選ぶ
          </button>
        </div>
      ) : (
        probe.status !== 'probing' && (
          <div className="dropzone" data-testid="drop-zone">
            <p className="dropzone-title">ここに音声ファイルをドラッグ＆ドロップ</p>
            <p className="hint">m4a / mp3 / wav / ogg / flac や、音声入りの mp4 などの動画が使えます。</p>
            <button type="button" className="btn btn-primary" onClick={open} data-testid="choose-file-button">
              ファイルを選ぶ
            </button>
          </div>
        )
      )}
    </section>
  );
}
