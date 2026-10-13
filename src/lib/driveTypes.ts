// Google Drive 連携でサーバー（GAS）とやりとりする型。サーバー関数の契約と同じ形。

export type DriveItem = {
  id: string; // ショートカットの場合はターゲットの ID
  name: string;
  type: 'file' | 'folder';
  mimeType: string;
  size: number | null; // バイト。フォルダや不明は null
  updated: number | null; // 更新時刻（ミリ秒）
  canDownload: boolean; // false = 所有者がダウンロードを禁止
  canAddChildren?: boolean; // フォルダのみ。そこへ保存できるか
  shortcut?: true;
  driveId?: string;
};

export type DriveFolder = {
  id: string;
  name: string;
  parentId: string | null;
  isRoot: boolean;
  driveId: string | null;
  canAddChildren: boolean;
};

/** 業務上の失敗は例外ではなく、この形の戻り値で返る */
export type GasError = { error: string; retryable?: true; code?: string };

export type DriveStatus = { enabled: true } | { enabled: false; reason: string };

export type ListFolderResult = { folder: DriveFolder; items: DriveItem[]; truncated?: boolean };
export type FolderPathResult = { path: { id: string; name: string }[] };
export type SearchResult = { query: string; items: DriveItem[]; truncated: boolean };
export type ResolveResult =
  | { kind: 'folder'; id: string; name: string }
  | { kind: 'file'; item: DriveItem; parentId: string | null };
export type CreateFolderResult = { success: true; id: string; name: string };

export type FileInfoResult = {
  success: true;
  id: string;
  name: string;
  size: number;
  mimeType: string;
  updated: number | null;
  parentId: string | null;
  chunkSize: number;
};
export type FileChunkResult = {
  success: true;
  offset: number;
  length: number;
  data: string; // base64。空なら ''
  etag: string | null;
  partial: boolean;
};
export type BeginUploadResult = { success: true; token: string; chunkSize: number };
export type UploadChunkResult =
  | { success: true; done: false; next: number }
  | { success: true; done: true; next: number; file: { id: string; name: string } };
export type AbortUploadResult = { success: true };

/** ダウンロード・保存が失敗したときの共通の例外 */
export class DriveTransferError extends Error {
  code?: string;
  /** 取得中にファイルが更新されたことによる失敗（内部用） */
  etagMismatch?: boolean;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'DriveTransferError';
    this.code = code;
  }
}
