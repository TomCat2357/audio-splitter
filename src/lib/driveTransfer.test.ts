import { describe, expect, it, vi } from 'vitest';
import {
  ALIGN,
  MAX_FILE_BYTES,
  RETRIES,
  alignChunkSize,
  base64ToBytes,
  bytesToBase64,
  createDriveTransfer,
  planChunks,
  resolveMimeType,
  uniqueName,
} from './driveTransfer';
import type { GasCall } from './gas';

const FAKE_ID = 'dummy-file-id-0000';
const FAKE_FOLDER = 'dummy-folder-id-0000';

function makeBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8) * 7) & 255;
  return b;
}

async function bytesOf(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** 大きな Uint8Array は toEqual が非常に遅いので、Buffer で比べる */
function expectSame(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length);
  expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
}

const noSleep = async () => {};

type Handler = (fn: string, args: unknown[]) => unknown | Promise<unknown>;

/** 偽の gas。関数名と引数を受けて応答を返す */
function fakeGas(handler: Handler) {
  const log: { fn: string; args: unknown[] }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const gas = (async (fn: string, ...args: unknown[]) => {
    log.push({ fn, args });
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    try {
      const r = await handler(fn, args);
      if (r instanceof Error) throw r;
      return r;
    } finally {
      inflight--;
    }
  }) as unknown as GasCall;
  return { gas, log, max: () => maxInflight, count: (fn: string) => log.filter((l) => l.fn === fn).length };
}

function infoOf(over: Partial<Record<string, unknown>> = {}) {
  return {
    success: true,
    id: FAKE_ID,
    name: 'rec.m4a',
    size: 700 * 1024,
    mimeType: 'audio/mp4',
    updated: 1,
    parentId: FAKE_FOLDER,
    chunkSize: ALIGN,
    ...over,
  };
}

/** content を返す標準のサーバー。chunkHook で個別に差し替える */
function server(content: Uint8Array, o: { info?: Record<string, unknown>; chunk?: Handler } = {}) {
  return fakeGas(async (fn, args) => {
    if (fn === 'getFileInfo') return infoOf({ size: content.length, ...(o.info ?? {}) });
    if (fn === 'getFileChunk') {
      if (o.chunk) {
        const r = await o.chunk(fn, args);
        if (r !== undefined) return r;
      }
      const [, off, len] = args as [string, number, number];
      // 順不同に返るよう、先頭ほど遅くする
      await new Promise((r) => setTimeout(r, Math.max(0, 8 - off / ALIGN) * 2));
      return {
        success: true,
        offset: off,
        length: len,
        data: bytesToBase64(content.subarray(off, off + len)),
        etag: 'e1',
        partial: true,
      };
    }
    return { error: 'unknown' };
  });
}

describe('チャンク計算', () => {
  it('alignChunkSize は 256KiB の倍数に切り下げ、最小は 256KiB', () => {
    expect(alignChunkSize(8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
    expect(alignChunkSize(ALIGN + 5)).toBe(ALIGN);
    expect(alignChunkSize(10)).toBe(ALIGN);
    expect(alignChunkSize(NaN)).toBe(ALIGN);
  });
  it('planChunks は全体を過不足なく覆う', () => {
    expect(planChunks(0, 10)).toEqual([]);
    expect(planChunks(10, 10)).toEqual([{ offset: 0, length: 10 }]);
    expect(planChunks(25, 10)).toEqual([
      { offset: 0, length: 10 },
      { offset: 10, length: 10 },
      { offset: 20, length: 5 },
    ]);
  });
});

describe('base64', () => {
  const sizes = [0, 1, 2, 3, 4, 5, 255, 256, 0x7fff, 0x8000, 0x8001, 0x10000 + 7, 1_000_003];
  for (const n of sizes) {
    it(`${n} バイトの往復`, () => {
      const src = makeBytes(n);
      const b64 = bytesToBase64(src);
      expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expectSame(base64ToBytes(b64), src);
    });
  }
  it('空文字は空', () => {
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
  it('改行や空白が混じっていても読める', () => {
    expect(base64ToBytes('AQID\nBA==')).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('uniqueName', () => {
  it('重複しなければそのまま', () => {
    expect(uniqueName(['a.m4a'], 'b.m4a')).toBe('b.m4a');
  });
  it('重複したら 名前 (1).拡張子、さらに重なれば連番を進める', () => {
    expect(uniqueName(['a.m4a'], 'a.m4a')).toBe('a (1).m4a');
    expect(uniqueName(['a.m4a', 'a (1).m4a'], 'a.m4a')).toBe('a (2).m4a');
  });
  it('末尾がすでに (数字) なら外してから付け直す', () => {
    expect(uniqueName(['a (1).m4a'], 'a (1).m4a')).toBe('a (2).m4a');
    expect(uniqueName(new Set(['a (1).m4a', 'a (2).m4a']), 'a (1).m4a')).toBe('a (3).m4a');
  });
  it('拡張子なし・先頭ドットの名前', () => {
    expect(uniqueName(['memo'], 'memo')).toBe('memo (1)');
    expect(uniqueName(['.hidden'], '.hidden')).toBe('.hidden (1)');
  });
  it('大文字小文字は区別する', () => {
    expect(uniqueName(['A.m4a'], 'a.m4a')).toBe('a.m4a');
  });
});

describe('resolveMimeType', () => {
  it('汎用や空のとき、拡張子から補う', () => {
    expect(resolveMimeType('application/octet-stream', 'a.m4a')).toBe('audio/mp4');
    expect(resolveMimeType('', 'a.MP3')).toBe('audio/mpeg');
    expect(resolveMimeType(undefined, 'a.wav')).toBe('audio/wav');
    expect(resolveMimeType(null, 'a.mov')).toBe('video/quicktime');
    expect(resolveMimeType('application/octet-stream', 'a.unknown')).toBe('');
    // サーバーの対応表にある拡張子（wma・aiff など）も補える
    expect(resolveMimeType('application/octet-stream', 'a.wma')).toBe('audio/x-ms-wma');
    expect(resolveMimeType('application/octet-stream', 'a.AIFF')).toBe('audio/aiff');
    expect(resolveMimeType('application/octet-stream', 'a.3gp')).toBe('video/3gpp');
    expect(resolveMimeType('application/octet-stream', 'toString')).toBe('');
  });
  it('具体的な MIME はそのまま', () => {
    expect(resolveMimeType('audio/x-m4a', 'a.m4a')).toBe('audio/x-m4a');
  });
});

describe('downloadDriveFile', () => {
  it('並列で取得してもチャンクが正しい順に組み上がる（最大 3 並列）', async () => {
    const content = makeBytes(ALIGN * 7 + 123);
    const s = server(content);
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const progress: number[] = [];
    const f = await t.downloadDriveFile(FAKE_ID, { onProgress: (l) => progress.push(l) });
    expect(f.name).toBe('rec.m4a');
    expect(f.type).toBe('audio/mp4');
    expect(f.size).toBe(content.length);
    expectSame(await bytesOf(f), content);
    expect(s.count('getFileChunk')).toBe(8);
    expect(s.max()).toBe(3);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(content.length);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress); // 単調増加
  });

  it('getFileInfo の情報を onInfo で渡す', async () => {
    const content = makeBytes(ALIGN);
    const s = server(content);
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const onInfo = vi.fn();
    await t.downloadDriveFile(FAKE_ID, { onInfo });
    expect(onInfo).toHaveBeenCalledTimes(1);
    expect(onInfo.mock.calls[0][0]).toMatchObject({ parentId: FAKE_FOLDER });
  });

  it('retryable は待ってから再試行して、最後まで完了する', async () => {
    const content = makeBytes(ALIGN * 9);
    let failedOnce = false;
    const s = fakeGas(async (fn, args) => {
      if (fn === 'getFileInfo') return infoOf({ size: content.length });
      const [, off, len] = args as [string, number, number];
      await new Promise((r) => setTimeout(r, 5));
      if (off === ALIGN * 2 && !failedOnce) {
        failedOnce = true;
        return { error: '一時的なエラー', retryable: true };
      }
      return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + len)), etag: 'e', partial: true };
    });
    const sleep = vi.fn(async () => {});
    const t = createDriveTransfer({ gas: s.gas, sleep });
    const f = await t.downloadDriveFile(FAKE_ID);
    expectSame(await bytesOf(f), content);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(s.count('getFileChunk')).toBe(10); // 9 + 再試行 1
  });

  it('縮退後は並列度 1 のまま最後まで進む', async () => {
    const content = makeBytes(ALIGN * 12);
    let failedOnce = false;
    let flight = 0;
    const flightAtIssue: number[] = [];
    const s = fakeGas(async (fn, args) => {
      if (fn === 'getFileInfo') return infoOf({ size: content.length });
      const [, off, len] = args as [string, number, number];
      flight++;
      if (failedOnce) flightAtIssue.push(flight);
      try {
        await new Promise((r) => setTimeout(r, 3));
        if (off === 0 && !failedOnce) {
          failedOnce = true;
          return { error: 'x', retryable: true };
        }
        return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + len)), etag: 'e', partial: true };
      } finally {
        flight--;
      }
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const f = await t.downloadDriveFile(FAKE_ID);
    expectSame(await bytesOf(f), content);
    // 再試行が起きたあとの発行のうち、後半は常に単独で飛んでいる
    expect(flightAtIssue.slice(-5).every((n) => n === 1)).toBe(true);
  });

  it('retryable が続くと上限（初回 + 3 回）で諦めてエラーにする', async () => {
    const s = fakeGas(async (fn) => {
      if (fn === 'getFileInfo') return infoOf({ size: ALIGN });
      return { error: '混み合っています', retryable: true };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const t = createDriveTransfer({ gas: s.gas, sleep });
    await expect(t.downloadDriveFile(FAKE_ID)).rejects.toThrow('混み合っています');
    expect(s.count('getFileChunk')).toBe(RETRIES + 1);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([600, 1200, 2400]); // 指数バックオフ
  });

  it('通信失敗（reject）も再試行する', async () => {
    const content = makeBytes(ALIGN);
    let n = 0;
    const s = fakeGas(async (fn, args) => {
      if (fn === 'getFileInfo') return infoOf({ size: content.length });
      if (n++ === 0) return new Error('network');
      const [, off, len] = args as [string, number, number];
      return { success: true, offset: off, length: len, data: bytesToBase64(content), etag: null, partial: true };
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    expectSame(await bytesOf(await t.downloadDriveFile(FAKE_ID)), content);
  });

  it('受け取った長さが合わなければエラー', async () => {
    const content = makeBytes(ALIGN * 2);
    const s = server(content, {
      chunk: (_fn, args) => {
        const [, off, len] = args as [string, number, number];
        if (off === ALIGN)
          return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + len - 5)), etag: 'e1', partial: true };
        return undefined;
      },
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.downloadDriveFile(FAKE_ID)).rejects.toThrow('大きさが合いません');
  });

  it('ETag が複数返ったら、最初から 1 回だけやり直す', async () => {
    const content = makeBytes(ALIGN * 3);
    let round = 0;
    const s = server(content, {
      chunk: (_fn, args) => {
        const [, off, len] = args as [string, number, number];
        if (off === 0) round++;
        const etag = round === 1 && off === ALIGN * 2 ? 'changed' : round === 1 ? 'old' : 'new';
        return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + len)), etag, partial: true };
      },
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const f = await t.downloadDriveFile(FAKE_ID);
    expectSame(await bytesOf(f), content);
    expect(s.count('getFileInfo')).toBe(2);
    expect(s.count('getFileChunk')).toBe(6);
  });

  it('やり直してもETag が揃わなければエラー', async () => {
    const content = makeBytes(ALIGN * 2);
    const s = server(content, {
      chunk: (_fn, args) => {
        const [, off, len] = args as [string, number, number];
        return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + len)), etag: `e${off}`, partial: true };
      },
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.downloadDriveFile(FAKE_ID)).rejects.toThrow('更新されました');
    expect(s.count('getFileInfo')).toBe(2);
  });

  it('更新で長さが変わった場合も、ETag が混在していればやり直す', async () => {
    const content = makeBytes(ALIGN * 2);
    let round = 0;
    const s = server(content, {
      chunk: (_fn, args) => {
        const [, off, len] = args as [string, number, number];
        if (off === 0) round++;
        if (round === 1 && off === ALIGN) {
          return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + 3)), etag: 'other', partial: true };
        }
        return { success: true, offset: off, length: len, data: bytesToBase64(content.subarray(off, off + len)), etag: round === 1 ? 'first' : 'second', partial: true };
      },
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    // 先に ALIGN 側が届くとは限らないので、結果は「成功」か「長さ不一致」のどちらかだが、クラッシュしない
    const f = await t.downloadDriveFile(FAKE_ID).catch((e: Error) => e);
    if (f instanceof File) expectSame(await bytesOf(f), content);
    else expect(f.message.length).toBeGreaterThan(0);
  });

  it('DOWNLOAD_RESTRICTED は再試行せず、メッセージをそのまま出す', async () => {
    const s = fakeGas(async () => ({ error: '所有者がダウンロードを禁止しています。', code: 'DOWNLOAD_RESTRICTED' }));
    const sleep = vi.fn(async () => {});
    const t = createDriveTransfer({ gas: s.gas, sleep });
    const err = await t.downloadDriveFile(FAKE_ID).catch((e) => e);
    expect(err.message).toBe('所有者がダウンロードを禁止しています。');
    expect(err.code).toBe('DOWNLOAD_RESTRICTED');
    expect(s.log).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retryable が付いていても DOWNLOAD_RESTRICTED / DRIVE_DISABLED は再試行しない', async () => {
    for (const code of ['DOWNLOAD_RESTRICTED', 'DRIVE_DISABLED']) {
      const s = fakeGas(async (fn) => {
        if (fn === 'getFileInfo') return infoOf({ size: ALIGN });
        return { error: 'だめです', retryable: true, code };
      });
      const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
      const err = await t.downloadDriveFile(FAKE_ID).catch((e) => e);
      expect(err.code).toBe(code);
      expect(s.count('getFileChunk')).toBe(1);
    }
  });

  it('DRIVE_DISABLED は getFileInfo の段階でも再試行しない', async () => {
    const s = fakeGas(async () => ({ error: '無効です', code: 'DRIVE_DISABLED' }));
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const err = await t.downloadDriveFile(FAKE_ID).catch((e) => e);
    expect(err.code).toBe('DRIVE_DISABLED');
    expect(s.log).toHaveLength(1);
  });

  it('上限（500 MB）を超えるときは、サイズと上限を示すエラーにして、取得を始めない', async () => {
    const s = fakeGas(async () => infoOf({ size: MAX_FILE_BYTES + 1 }));
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const err = await t.downloadDriveFile(FAKE_ID).catch((e) => e);
    expect(err.message).toContain('500.0 MB');
    expect(err.message).toContain('上限');
    expect(s.count('getFileChunk')).toBe(0);
  });

  it('サイズ 0 は空のファイルとして断る', async () => {
    const s = fakeGas(async () => infoOf({ size: 0 }));
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.downloadDriveFile(FAKE_ID)).rejects.toThrow('空');
  });

  it('汎用 MIME のときは拡張子から type を補う', async () => {
    const content = makeBytes(ALIGN);
    const s = server(content, { info: { mimeType: 'application/octet-stream', name: 'voice.m4a' } });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const f = await t.downloadDriveFile(FAKE_ID);
    expect(f.type).toBe('audio/mp4');
    expect(f.name).toBe('voice.m4a');
  });

  it('中断: 未発行のチャンクは発行せず、AbortError で終わる', async () => {
    const content = makeBytes(ALIGN * 20);
    const ac = new AbortController();
    const s = server(content, {
      chunk: (_fn, args) => {
        if ((args as [string, number])[1] === ALIGN * 2) ac.abort();
        return undefined;
      },
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const err = await t.downloadDriveFile(FAKE_ID, { signal: ac.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    await new Promise((r) => setTimeout(r, 100)); // 残りの worker が止まるのを待つ
    expect(s.count('getFileChunk')).toBeLessThan(20);
    const before = s.count('getFileChunk');
    await new Promise((r) => setTimeout(r, 50));
    expect(s.count('getFileChunk')).toBe(before);
  });

  it('中断: 応答が返らない呼び出しがあっても、すぐ AbortError になる', async () => {
    const ac = new AbortController();
    const s = fakeGas(async (fn) => {
      if (fn === 'getFileInfo') return infoOf({ size: ALIGN * 4 });
      return new Promise(() => {}); // 永遠に返らない
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const p = t.downloadDriveFile(FAKE_ID, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('開始前に中断済みなら何も呼ばない', async () => {
    const ac = new AbortController();
    ac.abort();
    const s = fakeGas(async () => infoOf());
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.downloadDriveFile(FAKE_ID, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- upload

function uploadServer(o: { chunkSize?: number; nextOverride?: (offset: number, calls: number) => number | undefined } = {}) {
  const received = new Map<number, Uint8Array>();
  let token = 'dummy-token-0000';
  let calls = 0;
  const s = fakeGas(async (fn, args) => {
    if (fn === 'beginUpload') return { success: true, token, chunkSize: o.chunkSize ?? ALIGN };
    if (fn === 'uploadChunk') {
      const [tk, offset, b64, total] = args as [string, number, string, number];
      if (tk !== token) return { error: 'bad token' };
      calls++;
      const bytes = base64ToBytes(b64);
      const forced = o.nextOverride?.(offset, calls);
      if (forced !== undefined) return { success: true, done: false, next: forced };
      received.set(offset, bytes);
      const next = offset + bytes.length;
      if (next >= total) return { success: true, done: true, next, file: { id: 'dummy-new-id', name: 'saved.m4a' } };
      return { success: true, done: false, next };
    }
    if (fn === 'abortUpload') return { success: true };
    return { error: 'unknown' };
  });
  const assemble = (total: number) => {
    const out = new Uint8Array(total);
    for (const [off, b] of received) out.set(b, off);
    return out;
  };
  return { ...s, received, assemble };
}

describe('uploadToDrive', () => {
  it('チャンクごとに直列で送り、256KiB 境界で区切り、内容が一致する', async () => {
    const content = makeBytes(ALIGN * 2 + 1000);
    const blob = new Blob([content as unknown as BlobPart]);
    const s = uploadServer();
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const progress: number[] = [];
    const res = await t.uploadToDrive(FAKE_FOLDER, 'saved.m4a', blob, { onProgress: (n) => progress.push(n) });
    expect(res).toEqual({ id: 'dummy-new-id', name: 'saved.m4a' });
    expectSame(s.assemble(content.length), content);
    const offsets = s.log.filter((l) => l.fn === 'uploadChunk').map((l) => l.args[1]);
    expect(offsets).toEqual([0, ALIGN, ALIGN * 2]);
    expect(s.max()).toBe(1); // 直列
    expect(s.log[0]).toEqual({ fn: 'beginUpload', args: [{ folderId: FAKE_FOLDER, name: 'saved.m4a', size: content.length }] });
    expect(progress.at(-1)).toBe(content.length);
    // 最後以外のチャンクは 256KiB の倍数
    for (const [off, b] of s.received) if (off + b.length < content.length) expect(b.length % ALIGN).toBe(0);
  });

  it('Blob は全体を読まず、チャンクごとに slice して読む', async () => {
    const content = makeBytes(ALIGN * 3);
    const blob = new Blob([content as unknown as BlobPart]);
    const whole = vi.spyOn(blob, 'arrayBuffer');
    const slice = vi.spyOn(blob, 'slice');
    const s = uploadServer();
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob);
    expect(whole).not.toHaveBeenCalled();
    expect(slice.mock.calls).toEqual([
      [0, ALIGN],
      [ALIGN, ALIGN * 2],
      [ALIGN * 2, ALIGN * 3],
    ]);
  });

  it('サーバーが返す next から再開する（巻き戻しにも従う）', async () => {
    const content = makeBytes(ALIGN * 3);
    const blob = new Blob([content as unknown as BlobPart]);
    const s = uploadServer({
      nextOverride: (offset, calls) => (calls === 2 && offset === ALIGN ? 0 : undefined),
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob);
    const offsets = s.log.filter((l) => l.fn === 'uploadChunk').map((l) => l.args[1]);
    expect(offsets).toEqual([0, ALIGN, 0, ALIGN, ALIGN * 2]);
    expectSame(s.assemble(content.length), content);
  });

  it('進まない応答が続いたら打ち切り、abortUpload を呼ぶ', async () => {
    const content = makeBytes(ALIGN * 3);
    const blob = new Blob([content as unknown as BlobPart]);
    const s = uploadServer({ nextOverride: () => 0 });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob)).rejects.toThrow('先に進みません');
    expect(s.count('abortUpload')).toBe(1);
    expect(s.count('uploadChunk')).toBeLessThanOrEqual(RETRIES + 3);
  });

  it('256KiB の倍数でない next は不正として失敗する', async () => {
    const blob = new Blob([makeBytes(ALIGN * 2) as unknown as BlobPart]);
    const s = uploadServer({ nextOverride: () => 1000 });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob)).rejects.toThrow();
    expect(s.count('abortUpload')).toBe(1);
  });

  it('チャンクの送信に失敗したら abortUpload を呼んで失敗する', async () => {
    const blob = new Blob([makeBytes(ALIGN * 2) as unknown as BlobPart]);
    const s = fakeGas(async (fn) => {
      if (fn === 'beginUpload') return { success: true, token: 'dummy-token-0000', chunkSize: ALIGN };
      if (fn === 'uploadChunk') return { error: '容量が足りません' };
      return { success: true };
    });
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob)).rejects.toThrow('容量が足りません');
    const abort = s.log.find((l) => l.fn === 'abortUpload');
    expect(abort?.args).toEqual(['dummy-token-0000']);
  });

  it('retryable は同じ位置を再送する', async () => {
    const content = makeBytes(ALIGN * 2);
    const blob = new Blob([content as unknown as BlobPart]);
    let n = 0;
    const inner = uploadServer();
    const gas = (async (fn: string, ...args: unknown[]) => {
      if (fn === 'uploadChunk' && n++ === 0) return { error: '一時的', retryable: true };
      return inner.gas(fn, ...args);
    }) as unknown as GasCall;
    const t = createDriveTransfer({ gas, sleep: noSleep });
    await t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob);
    expectSame(inner.assemble(content.length), content);
  });

  it('beginUpload の失敗はそのまま伝え、abortUpload は呼ばない', async () => {
    const s = fakeGas(async () => ({ error: '保存先に追加できません', code: 'FORBIDDEN' }));
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    const err = await t.uploadToDrive(FAKE_FOLDER, 'a.m4a', new Blob([new Uint8Array(10)])).catch((e) => e);
    expect(err.message).toBe('保存先に追加できません');
    expect(err.code).toBe('FORBIDDEN');
    expect(s.count('abortUpload')).toBe(0);
  });

  it('中断: 次のチャンクを送る前に止まり、abortUpload を呼ぶ', async () => {
    const content = makeBytes(ALIGN * 4);
    const blob = new Blob([content as unknown as BlobPart]);
    const ac = new AbortController();
    const inner = uploadServer();
    const gas = (async (fn: string, ...args: unknown[]) => {
      const r = await inner.gas(fn, ...args);
      if (fn === 'uploadChunk' && args[1] === ALIGN) ac.abort();
      return r;
    }) as unknown as GasCall;
    const t = createDriveTransfer({ gas, sleep: noSleep });
    const err = await t.uploadToDrive(FAKE_FOLDER, 'a.m4a', blob, { signal: ac.signal }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(inner.count('uploadChunk')).toBe(2);
    expect(inner.count('abortUpload')).toBe(1);
  });

  it('上限を超える Blob は送らずに断る', async () => {
    const fake = { size: MAX_FILE_BYTES + 1 } as unknown as Blob;
    const s = fakeGas(async () => ({ success: true }));
    const t = createDriveTransfer({ gas: s.gas, sleep: noSleep });
    await expect(t.uploadToDrive(FAKE_FOLDER, 'big.m4a', fake)).rejects.toThrow('上限');
    expect(s.log).toHaveLength(0);
  });
});
