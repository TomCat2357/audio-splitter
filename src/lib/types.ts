/** 読み込んだファイルの情報 */
export interface AudioInfo {
  fileName: string;
  fileSize: number; // bytes
  containerLabel: string; // 'MP4' 'MP3' 'WAVE' など表示用
  codec: string; // 'aac' 'mp3' 'pcm-s16' など
  durationSec: number;
  sampleRate: number;
  numberOfChannels: number;
  hasVideo: boolean;
  audioBitrate: number; // 音声トラックの平均ビットレート(bps)の推定値
  /** 無劣化コピーで出力するときの形式。コピー不可なら null */
  copyFormat: { ext: string; mime: string; label: string } | null;
  /** このブラウザで音声をデコードできるか（圧縮＝再エンコードに必要） */
  canDecode: boolean;
}

export type EncodeFormat = 'm4a' | 'mp3';

export type OutputSpec =
  | { kind: 'copy' } // 無劣化
  | { kind: 'encode'; format: EncodeFormat; bitrate: number; mono: boolean }; // bitrate は bps

export type SplitPlan =
  | { kind: 'points'; points: number[] } // 分割点（秒）。空配列なら分割なしで 1 ファイル
  | { kind: 'maxSize'; maxBytes: number }; // 各パートがこのサイズ以下になるよう自動分割

export interface OutputPart {
  index: number; // 0 始まり
  fileName: string;
  blob: Blob; // type に適切な MIME を入れる
  startSec: number; // 元ファイル上の開始位置
  endSec: number;
  durationSec: number; // 出力ファイルの実際の長さ
}

export interface JobProgress {
  overall: number; // 0〜1
  partIndex: number; // いま処理中のパート（0 始まり）
  estimatedParts: number; // maxSize では概算
}

export interface JobCallbacks {
  onProgress?: (p: JobProgress) => void;
  onPart?: (part: OutputPart) => void; // 1 パート完成するたびに呼ぶ
  signal?: AbortSignal; // abort されたら中断して AbortError 相当を投げる
}
