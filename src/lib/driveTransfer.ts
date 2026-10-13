// Drive との間のファイル転送（google.script.run 経由の base64 チャンク）。
// - ダウンロード: getFileInfo → getFileChunk を最大 3 並列。結果は「チャンクの配列のまま」File にする
//   （ファイル全体を 1 個の巨大な Uint8Array にしない）。
// - アップロード: beginUpload → uploadChunk を直列。Blob はチャンクごとに slice().arrayBuffer() で読む。
// DOM 非依存（File / Blob / atob / btoa は Node でも使える）。createDriveTransfer(deps) で gas / sleep を差し替えられる。

import { gasCall, isGasError, type GasCall } from './gas';
import { formatBytes } from './plan';
import {
  DriveTransferError,
  type AbortUploadResult,
  type BeginUploadResult,
  type FileChunkResult,
  type FileInfoResult,
  type GasError,
  type UploadChunkResult,
} from './driveTypes';

/** アップロードのチャンクの単位（最後の 1 個以外はこの倍数） */
export const ALIGN = 256 * 1024;
/** サーバーが chunkSize を返さなかったときの既定（8 MiB） */
export const DEFAULT_CHUNK = 32 * ALIGN;
/** 1 ファイルの上限（ダウンロード・保存とも。サーバー側の上限と同じ） */
export const MAX_FILE_BYTES = 500 * 1024 * 1024;
export const RETRIES = 3;
export const BASE_DELAY_MS = 600;
export const DOWNLOAD_CONCURRENCY = 3;

/** 再試行しても無駄なエラーコード */
const NO_RETRY_CODES = new Set(['DOWNLOAD_RESTRICTED', 'DRIVE_DISABLED']);

// ---------------------------------------------------------------- 純粋な補助

/** n 以下で最大の 256KiB の倍数（最小 256KiB） */
export function alignChunkSize(n: number): number {
  const v = Math.floor(Number(n) / ALIGN) * ALIGN;
  return v >= ALIGN ? v : ALIGN;
}

/** [0, total) を chunkSize ごとに分けた { offset, length } の配列 */
export function planChunks(total: number, chunkSize: number): { offset: number; length: number }[] {
  const out: { offset: number; length: number }[] = [];
  if (!(chunkSize > 0)) return out;
  for (let o = 0; o < total; o += chunkSize) out.push({ offset: o, length: Math.min(chunkSize, total - o) });
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const str = String(base64 ?? '').replace(/\s/g, '');
  if (!str) return new Uint8Array(0);
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (typeof native === 'function') {
    try {
      return native.call(Uint8Array, str);
    } catch {
      /* 手書きの変換へ */
    }
  }
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const STEP = 0x8000; // 引数の個数の上限に当たらない大きさ
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += STEP) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]));
  }
  return btoa(parts.join(''));
}

function splitExt(name: string): { stem: string; ext: string } {
  const lead = /^\.*/.exec(name)![0].length;
  const i = name.lastIndexOf('.');
  return i > 0 && i >= lead ? { stem: name.slice(0, i), ext: name.slice(i) } : { stem: name, ext: '' };
}

/**
 * 同名があるとき `名前 (1).拡張子` と連番を付ける。すでに末尾が "(数字)" ならそれを外して付け直す
 * （`a (1) (1)` にしない）。大文字小文字は区別する（Drive と同じ）。
 */
export function uniqueName(existingNames: Iterable<string>, desired: string): string {
  const set = existingNames instanceof Set ? (existingNames as Set<string>) : new Set(existingNames);
  if (!set.has(desired)) return desired;
  const { stem: s0, ext } = splitExt(desired);
  const m = /^(.*?)\s*\(\d+\)$/.exec(s0);
  const stem = m && m[1] ? m[1] : s0;
  for (let i = 1; ; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!set.has(cand)) return cand;
  }
}

const EXT_MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

export function mimeFromName(name: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? (EXT_MIME[m[1].toLowerCase()] ?? null) : null;
}

/** getFileInfo の mimeType が汎用・空のとき、拡張子から音声・動画の MIME を補う */
export function resolveMimeType(mimeType: string | null | undefined, name: string): string {
  const mt = (mimeType ?? '').trim().toLowerCase();
  const generic = !mt || mt === 'application/octet-stream' || mt === 'binary/octet-stream';
  if (!generic) return mimeType!.trim();
  return mimeFromName(name) ?? '';
}

export function abortError(message = '中止しました。'): DriveTransferError {
  const e = new DriveTransferError(message);
  e.name = 'AbortError';
  return e;
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

/** 取り消せない呼び出しの待ちを、中断ですぐ抜けられるようにする（応答は捨てる） */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  p.catch(() => {});
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** 通信失敗など生の Error を、利用者に見せられる形にする */
function toTransferError(e: unknown, fallback: string): Error {
  if (e instanceof DriveTransferError) return e;
  const raw = e instanceof Error ? e.message : String(e ?? '');
  return new DriveTransferError(`${fallback}（通信に失敗しました${raw ? `: ${raw}` : ''}）`);
}

function fail(res: GasError | null | undefined, fallback: string): DriveTransferError {
  return new DriveTransferError(res?.error || fallback, res?.code);
}

// ---------------------------------------------------------------- 転送

export interface TransferDeps {
  gas?: GasCall;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
}

export interface DownloadOptions {
  onProgress?: (loaded: number, total: number) => void;
  /** getFileInfo の結果が得られたとき（やり直しで取り直したときも） */
  onInfo?: (info: FileInfoResult) => void;
  signal?: AbortSignal;
  concurrency?: number;
}

export interface UploadOptions {
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export function createDriveTransfer(deps: TransferDeps = {}) {
  const gas = deps.gas ?? gasCall;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const baseDelay = deps.baseDelayMs ?? BASE_DELAY_MS;

  /** gas 呼び出し + 再試行。通信失敗と retryable は再試行、それ以外の { error } はそのまま返す */
  async function call<T>(
    fn: string,
    args: unknown[],
    o: { onRetry?: () => void; retries?: number; signal?: AbortSignal } = {},
  ): Promise<T | GasError> {
    const retries = o.retries ?? RETRIES;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      throwIfAborted(o.signal);
      try {
        const res = await gas<T>(fn, ...args);
        if (isGasError(res) && res.retryable && !(res.code && NO_RETRY_CODES.has(res.code)) && attempt < retries) {
          lastErr = new DriveTransferError(res.error, res.code);
          o.onRetry?.();
        } else {
          return res;
        }
      } catch (e) {
        lastErr = e;
        if (attempt < retries) o.onRetry?.();
      }
      if (attempt < retries) await sleep(baseDelay * 2 ** attempt);
    }
    throw lastErr;
  }

  // ------------------------------------------------------------ download

  async function getInfo(fileId: string, signal?: AbortSignal): Promise<FileInfoResult> {
    let res: FileInfoResult | GasError;
    try {
      res = await call<FileInfoResult>('getFileInfo', [fileId], { signal });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw toTransferError(e, 'ファイルの情報を取得できませんでした');
    }
    if (isGasError(res) || !res || res.success !== true) {
      throw fail(isGasError(res) ? res : null, 'ファイルの情報を取得できませんでした。');
    }
    if (!(res.size > 0)) throw new DriveTransferError('このファイルは中身が空のため、開けません。');
    if (res.size > MAX_FILE_BYTES) {
      throw new DriveTransferError(
        `このファイルは ${formatBytes(res.size)} あり、扱える上限（${formatBytes(MAX_FILE_BYTES)}）を超えています。`,
        'TOO_LARGE',
      );
    }
    return res;
  }

  /** チャンクを取得して、チャンクの配列（順序どおり）を返す。ETag が揃わなければ etagMismatch の例外 */
  async function downloadChunks(info: FileInfoResult, opts: DownloadOptions): Promise<Uint8Array[]> {
    const { signal } = opts;
    const size = info.size;
    const chunk = alignChunkSize(info.chunkSize || DEFAULT_CHUNK);
    const plan = planChunks(size, chunk);
    const parts: Uint8Array[] = new Array(plan.length);
    const etags = new Set<string>();
    let loaded = 0;
    let next = 0;
    let throttled = false; // 再試行が 1 回でも起きたら 1 並列に縮退
    let failed: unknown = null;
    opts.onProgress?.(0, size);

    async function worker(id: number) {
      while (!failed && next < plan.length) {
        if (throttled && id > 0) return;
        throwIfAborted(signal);
        const pi = next++;
        const p = plan[pi];
        const res = await call<FileChunkResult>('getFileChunk', [info.id, p.offset, p.length], {
          signal,
          onRetry: () => {
            throttled = true;
          },
        });
        if (failed) return;
        throwIfAborted(signal);
        if (isGasError(res) || !res || res.success !== true) {
          throw fail(isGasError(res) ? res : null, 'ファイルの取得に失敗しました。');
        }
        const bytes = base64ToBytes(res.data);
        if (res.etag) etags.add(res.etag);
        if (bytes.length !== p.length) {
          const e = new DriveTransferError(
            `ファイルの取得に失敗しました（受け取った大きさが合いません: ${bytes.length} / ${p.length}）。`,
          );
          if (etags.size > 1) e.etagMismatch = true; // 版が混在 = 取得中の更新による長さの変化
          throw e;
        }
        parts[pi] = bytes;
        loaded += bytes.length;
        opts.onProgress?.(loaded, size);
      }
    }

    const n = Math.max(1, Math.min(Math.floor(opts.concurrency ?? DOWNLOAD_CONCURRENCY), plan.length));
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      tasks.push(
        worker(i).catch((e) => {
          if (!failed) failed = e;
        }),
      );
    }
    await Promise.all(tasks);
    if (failed) throw failed;
    if (etags.size > 1) {
      const e = new DriveTransferError('取得中にファイルが更新されました。');
      e.etagMismatch = true;
      throw e;
    }
    return parts;
  }

  async function downloadBody(fileId: string, opts: DownloadOptions): Promise<File> {
    let info = await getInfo(fileId, opts.signal);
    opts.onInfo?.(info);
    let parts: Uint8Array[];
    try {
      parts = await downloadChunks(info, opts);
    } catch (e) {
      if (!(e instanceof DriveTransferError) || !e.etagMismatch) {
        if (e instanceof DriveTransferError || isAbort(e)) throw e;
        throw toTransferError(e, 'ファイルの取得に失敗しました');
      }
      // 取得中に更新された: 最新の情報で 1 回だけ最初からやり直す
      info = await getInfo(fileId, opts.signal);
      opts.onInfo?.(info);
      try {
        parts = await downloadChunks(info, opts);
      } catch (e2) {
        if (e2 instanceof DriveTransferError && e2.etagMismatch) {
          throw new DriveTransferError('取得中にファイルが更新されました。もう一度お試しください。');
        }
        if (e2 instanceof DriveTransferError || isAbort(e2)) throw e2;
        throw toTransferError(e2, 'ファイルの取得に失敗しました');
      }
    }
    return new File(parts as unknown as BlobPart[], info.name, { type: resolveMimeType(info.mimeType, info.name) });
  }

  /** Drive のファイルを全体ダウンロードして File にする（signal で中断。応答待ちの呼び出しは取り消せないので応答を捨てる） */
  function downloadDriveFile(fileId: string, opts: DownloadOptions = {}): Promise<File> {
    if (opts.signal?.aborted) return Promise.reject(abortError());
    return raceAbort(downloadBody(fileId, opts), opts.signal);
  }

  // ------------------------------------------------------------ upload

  async function uploadBody(
    folderId: string,
    name: string,
    blob: Blob,
    opts: UploadOptions,
  ): Promise<{ id: string; name: string }> {
    const { signal } = opts;
    const total = blob.size;
    if (total > MAX_FILE_BYTES) {
      throw new DriveTransferError(
        `「${name}」は ${formatBytes(total)} あり、保存できる上限（${formatBytes(MAX_FILE_BYTES)}）を超えています。`,
      );
    }
    throwIfAborted(signal);
    const begin = await call<BeginUploadResult>('beginUpload', [{ folderId, name, size: total }], { signal });
    if (isGasError(begin) || !begin || begin.success !== true) {
      throw fail(isGasError(begin) ? begin : null, '保存を開始できませんでした。');
    }
    const token = begin.token;
    const chunk = alignChunkSize(begin.chunkSize || DEFAULT_CHUNK);
    opts.onProgress?.(0, total);
    let offset = 0;
    let stalls = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const len = Math.min(chunk, total - offset);
        const buf = await blob.slice(offset, offset + len).arrayBuffer();
        const b64 = bytesToBase64(new Uint8Array(buf));
        const res = await call<UploadChunkResult>('uploadChunk', [token, offset, b64, total], { signal });
        if (isGasError(res) || !res || res.success !== true) {
          throw fail(isGasError(res) ? res : null, '保存に失敗しました。');
        }
        if (res.done) {
          opts.onProgress?.(total, total);
          return res.file;
        }
        const nx = Number(res.next);
        if (!(nx >= 0 && nx < total)) throw new DriveTransferError('サーバーの応答が正しくありません。');
        if (nx % ALIGN !== 0) throw new DriveTransferError('サーバーの応答が正しくありません（位置が合いません）。');
        // 進まない応答が続くなら打ち切る
        stalls = nx > offset ? 0 : stalls + 1;
        if (stalls > RETRIES) throw new DriveTransferError('保存が先に進みません。もう一度お試しください。');
        offset = nx;
        opts.onProgress?.(offset, total);
      }
    } catch (e) {
      try {
        await gas<AbortUploadResult>('abortUpload', token); // ベストエフォート
      } catch {
        /* 無視 */
      }
      if (e instanceof DriveTransferError || isAbort(e)) throw e;
      throw toTransferError(e, '保存に失敗しました');
    }
  }

  /**
   * Blob を Drive のフォルダに新規ファイルとして保存する。
   * 中断は次のチャンクを送る前に効く（実行中の 1 チャンクの応答は待つ。サーバーに確定済みかを正しく知るため）。
   */
  function uploadToDrive(
    folderId: string,
    name: string,
    blob: Blob,
    opts: UploadOptions = {},
  ): Promise<{ id: string; name: string }> {
    return uploadBody(folderId, name, blob, opts);
  }

  return { downloadDriveFile, uploadToDrive, call };
}

const defaultTransfer = createDriveTransfer();
export const downloadDriveFile = defaultTransfer.downloadDriveFile;
export const uploadToDrive = defaultTransfer.uploadToDrive;
