import { zip } from 'fflate';
import type { OutputPart } from './types';

/**
 * パートを無圧縮（store, level 0）の ZIP にまとめる。音声は既に圧縮済みなので再圧縮しない。
 * 非同期 API（fflate の zip）を使い、UI を固めない。
 * fflate は非 ASCII のファイル名を UTF-8 で記録し、UTF-8 フラグ(bit 11)も立てるので日本語名が化けない。
 */
export async function zipParts(parts: OutputPart[]): Promise<Blob> {
  const files: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const p of parts) {
    const data = new Uint8Array(await p.blob.arrayBuffer());
    files[p.fileName] = [data, { level: 0 }];
  }
  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, (err, data) => (err ? reject(err) : resolve(data)));
  });
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}
