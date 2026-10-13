// 突き合わせテスト（転送編）: 画面側の実コード（src/lib/gas.ts・driveTransfer.ts・driveStatus.ts）を、
// 本物の gas/Code.gs（node:vm、GAS のサービスはメモリ上の Drive のスタブ）につないで動かす。
// 偽物どうしではなく「実コード対実コード」なので、契約の解釈の食い違いがあればここで落ちる。
// 20 MB のデータを扱うのは 2 本だけ（サーバー既定の 8 MiB チャンク）。他は chunkUnits でサーバーのチャンクを小さくして、小さいデータで複数チャンクを試す。
import { describe, it, expect } from 'vitest';
import { MiB, bufOf, expectNoSerializationViolations, makeEnv, same } from './helpers/contract-env.mjs';
import { KB256, randomBytes } from './helpers/fake-drive.mjs';
import { checkDriveEnabled } from '../src/lib/driveStatus.ts';

expectNoSerializationViolations();

const RESTRICTED_MESSAGE = '所有者によりダウンロードが制限されているため、ファイルを取得できません。';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const monotonic = (xs) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

describe('ダウンロード（downloadDriveFile ↔ getFileInfo / getFileChunk）', () => {
  it('20 MB（既定の 8 MiB チャンクで 3 チャンク）が 1 バイトも違わず届く。octet-stream の .m4a は音声の MIME になる。進捗は単調増加で全体に達する', async () => {
    const e = makeEnv();
    const data = randomBytes(20 * MiB + 12345, 7);
    const node = e.fake.addFile('long-recording.m4a', 'application/octet-stream', data, e.fake.rootId, { id: 'FAKEFILE-BIG-DOWN-01' });
    const progress = [];
    const file = await e.transfer.downloadDriveFile(node.id, { onProgress: (l, t) => progress.push([l, t]) });
    expect(file.name).toBe('long-recording.m4a');
    expect(file.type).toBe('audio/mp4');
    expect(file.size).toBe(data.length);
    expect(same(await bufOf(file), data)).toBe(true);
    expect(e.g.count('getFileChunk')).toBe(3);
    expect(e.fake.fetchLog.filter((f) => f.kind === 'download').map((f) => f.range).sort()).toEqual(
      [`bytes=0-${8 * MiB - 1}`, `bytes=${8 * MiB}-${16 * MiB - 1}`, `bytes=${16 * MiB}-${data.length - 1}`].sort(),
    );
    expect(progress[0]).toEqual([0, data.length]);
    expect(progress.at(-1)).toEqual([data.length, data.length]);
    expect(monotonic(progress.map((p) => p[0]))).toBe(true);
    expect(progress.every((p) => p[1] === data.length)).toBe(true);
  });

  it('チャンク境界ちょうど（8 MiB）は 1 チャンク。MIME が audio/* ならそのまま', async () => {
    const e = makeEnv();
    const data = randomBytes(8 * MiB, 3);
    const node = e.fake.addFile('exact.mp3', 'audio/mpeg', data, e.fake.rootId, { id: 'FAKEFILE-EXACT-0001' });
    const file = await e.transfer.downloadDriveFile(node.id);
    expect(file.type).toBe('audio/mpeg');
    expect(same(await bufOf(file), data)).toBe(true);
    expect(e.g.count('getFileChunk')).toBe(1);
  });

  it('小さいファイル・1 バイト・チャンク境界の前後（256 KiB チャンク）', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const sizes = [1, 7, KB256 - 1, KB256, KB256 + 1, 2 * KB256, 2 * KB256 + 1, 3 * KB256];
    for (const size of sizes) {
      const data = randomBytes(size, size);
      const node = e.fake.addFile(`b${size}.wav`, 'audio/wav', data, e.fake.rootId);
      const before = e.g.count('getFileChunk');
      const file = await e.transfer.downloadDriveFile(node.id);
      expect(same(await bufOf(file), data), `size=${size}`).toBe(true);
      expect(e.g.count('getFileChunk') - before, `size=${size}`).toBe(Math.ceil(size / KB256));
    }
  });

  it('ショートカットの ID を渡しても、ターゲットの中身と名前で届く', async () => {
    const e = makeEnv();
    const file = await e.transfer.downloadDriveFile(e.ids.scAudio);
    expect(file.name).toBe('rec-a.m4a');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('AAAA-rec-a');
  });

  it('UrlFetchApp が一時的に 500 / 429 を返すと、サーバーは DriveApp でファイル全体を読まず retryable で返し、画面側の再試行を通って成功する', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } }); // DriveApp は使える状態のまま（使えても入らないことの確認）
    const data = randomBytes(4 * KB256, 12);
    const node = e.fake.addFile('retry.m4a', 'audio/mp4', data, e.fake.rootId);
    e.fake.faults.push({ kind: 'download', status: 500, times: 1 }, { kind: 'download', status: 429, times: 1 });
    const file = await e.transfer.downloadDriveFile(node.id);
    expect(same(await bufOf(file), data)).toBe(true);
    expect(e.fake.driveAppCalls).toEqual([]); // サーバーのフォールバックを通っていない
    expect(e.g.log.filter((l) => l.fn === 'getFileChunk' && l.result?.includes('"retryable":true')).length).toBe(2);
    expect(e.g.count('getFileChunk')).toBe(6); // 4 チャンク + 再試行 2 回（従来はフォールバックで成功し 4 回だった）
    expect(e.fake.fetchLog.filter((f) => f.kind === 'download')).toHaveLength(6);
  });

  it('再試行が起きたあとの新しいチャンクは、同時実行数 1 で取りに行く（混雑対策）。再試行がなければ 3 並列のまま', async () => {
    const seen = [];
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'getFileChunk') seen.push({ index, active: e.g.stats().active }); },
    });
    const data = randomBytes(8 * KB256, 13);
    const node = e.fake.addFile('throttle.m4a', 'audio/mp4', data, e.fake.rootId);
    e.fake.faults.push({ kind: 'download', status: 503, times: 1 }); // 最初の 1 回だけ失敗
    const file = await e.transfer.downloadDriveFile(node.id);
    expect(same(await bufOf(file), data)).toBe(true);
    expect(e.fake.driveAppCalls).toEqual([]);
    expect(e.g.count('getFileChunk')).toBe(9); // 8 チャンク + 再試行 1 回
    // 最初の 3 つは並列に出る。1・2 番目の応答 = retryable の後に取りに行く新しいチャンク（6 番目以降）は 1 つずつ
    expect(Math.max(...seen.filter((s) => s.index <= 3).map((s) => s.active))).toBe(3);
    expect(seen.filter((s) => s.index >= 5).map((s) => s.active)).toEqual([1, 1, 1, 1, 1]);

    // 対照: 失敗が無ければ、最後まで 3 並列で取る
    const seen2 = [];
    const e2 = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'getFileChunk') seen2.push({ index, active: e2.g.stats().active }); },
    });
    const n2 = e2.fake.addFile('plain.m4a', 'audio/mp4', data, e2.fake.rootId);
    await e2.transfer.downloadDriveFile(n2.id);
    expect(e2.g.count('getFileChunk')).toBe(8);
    expect(Math.max(...seen2.filter((s) => s.index >= 4).map((s) => s.active))).toBeGreaterThan(1);
  });

  it('UrlFetchApp の例外（タイムアウトなど）も、フォールバックせず retryable で返り、再試行で成功する', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const data = randomBytes(2 * KB256, 14);
    const node = e.fake.addFile('timeout.m4a', 'audio/mp4', data, e.fake.rootId);
    e.fake.faults.push({ kind: 'download', throwBefore: true, times: 1 });
    const file = await e.transfer.downloadDriveFile(node.id);
    expect(same(await bufOf(file), data)).toBe(true);
    expect(e.fake.driveAppCalls).toEqual([]);
    expect(e.g.log.filter((l) => l.fn === 'getFileChunk' && l.result?.includes('"retryable":true'))).toHaveLength(1);
  });

  it('失敗が続くと再試行を使い切ってエラー（サーバーの日本語メッセージが出る）。ガード後の 1 チャンクあたり 4 回まで。DriveApp は使わない', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const node = e.fake.addFile('dead.m4a', 'audio/mp4', randomBytes(KB256, 1), e.fake.rootId);
    e.fake.faults.push({ kind: 'download', status: 503, times: 99 });
    await expect(e.transfer.downloadDriveFile(node.id)).rejects.toThrow(/Google ドライブが混み合っている/);
    expect(e.g.count('getFileChunk')).toBe(4);
    expect(e.fake.driveAppCalls).toEqual([]);
  });

  it('ダウンロード禁止: 再試行せず、サーバーの日本語メッセージがそのままエラーになる（チャンクは 1 回も取りに行かない）', async () => {
    const e = makeEnv();
    const err = await e.transfer.downloadDriveFile(e.ids.locked).catch((x) => x);
    expect(err.message).toBe(RESTRICTED_MESSAGE);
    expect(err.code).toBe('DOWNLOAD_RESTRICTED');
    expect(e.g.count('getFileInfo')).toBe(1);
    expect(e.g.count('getFileChunk')).toBe(0);
  });

  it('取得の途中で禁止された場合（チャンク側で 403）も、再試行せずに DOWNLOAD_RESTRICTED になる', async () => {
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'getFileChunk' && index === 1) e.fake.nodes.get('FAKEFILE-FLIP-00001').canDownload = false; },
    });
    e.fake.addFile('flip.m4a', 'audio/mp4', randomBytes(6 * KB256, 4), e.fake.rootId, { id: 'FAKEFILE-FLIP-00001' });
    const err = await e.transfer.downloadDriveFile('FAKEFILE-FLIP-00001').catch((x) => x);
    expect(err.code).toBe('DOWNLOAD_RESTRICTED');
    expect(err.message).toBe(RESTRICTED_MESSAGE);
    expect(e.g.count('getFileChunk')).toBeLessThanOrEqual(3); // 最初の並列分だけ。再試行はしない
  });

  it('取得中にファイルが更新された（ETag が混在）: 画面側が最初からやり直し、新しい版が届く', async () => {
    const oldData = randomBytes(4 * KB256, 21);
    const newData = randomBytes(4 * KB256, 22);
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'getFileChunk' && index === 2) e.fake.replaceContent('FAKEFILE-VER-000001', newData); },
    });
    e.fake.addFile('ver.m4a', 'audio/mp4', oldData, e.fake.rootId, { id: 'FAKEFILE-VER-000001' });
    const file = await e.transfer.downloadDriveFile('FAKEFILE-VER-000001');
    expect(same(await bufOf(file), newData)).toBe(true);
    expect(e.g.count('getFileInfo')).toBe(2);
  });

  it('ETag ヘッダの綴り（ETag / Etag / etag）が違っても取得できる', async () => {
    for (const etagHeader of ['ETag', 'Etag', 'etag']) {
      const e = makeEnv({ server: { chunkUnits: 1 }, fake: { etagHeader } });
      const node = e.fake.addFile('e.m4a', 'audio/mp4', randomBytes(2 * KB256, 5), e.fake.rootId);
      const file = await e.transfer.downloadDriveFile(node.id);
      expect(file.size).toBe(2 * KB256);
      expect(e.g.log.some((l) => l.fn === 'getFileChunk' && l.result?.includes('"etag":"'))).toBe(true);
    }
  });

  it('ガードが無効（アクセスユーザーが違う）: 画面側のダウンロードが DRIVE_DISABLED で失敗し、再試行せず、Drive に触れない', async () => {
    const e = makeEnv({ fake: { active: 'visitor@example.test' } });
    const err = await e.transfer.downloadDriveFile(e.ids.rec).catch((x) => x);
    expect(err.code).toBe('DRIVE_DISABLED');
    expect(err.message).toBe('この配信設定では Google ドライブ連携は使えません。');
    expect(e.g.names()).toEqual(['getFileInfo']);
    expect(e.fake.fetchLog).toEqual([]);
  });

  it('中断: ダウンロードの途中で abort すると AbortError で終わり、その後は新しいチャンクを取りに行かない', async () => {
    const ac = new AbortController();
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'getFileChunk' && index === 2) ac.abort(); },
    });
    const node = e.fake.addFile('abort.m4a', 'audio/mp4', randomBytes(12 * KB256, 6), e.fake.rootId);
    const err = await e.transfer.downloadDriveFile(node.id, { signal: ac.signal }).catch((x) => x);
    expect(err.name).toBe('AbortError');
    await tick(60);
    const n = e.g.count('getFileChunk');
    await tick(60);
    expect(e.g.count('getFileChunk')).toBe(n);
    expect(n).toBeLessThan(12);
  });
});

describe('アップロード（uploadToDrive ↔ beginUpload / uploadChunk / abortUpload）', () => {
  it('20 MB（8 MiB チャンクで 3 チャンク）が、指定のフォルダ・名前・拡張子から決まる MIME・同一の中身で Drive にできる。進捗は単調増加', async () => {
    const e = makeEnv();
    const data = randomBytes(20 * MiB + 54321, 9);
    const progress = [];
    const res = await e.transfer.uploadToDrive(e.ids.music, 'out_001.m4a', new Blob([data]), { onProgress: (s, t) => progress.push([s, t]) });
    const node = e.fake.nodes.get(res.id);
    expect(res).toEqual({ id: node.id, name: 'out_001.m4a' });
    expect(node.parents).toEqual([e.ids.music]);
    expect(node.mimeType).toBe('audio/mp4');
    expect(same(node.content, data)).toBe(true);
    expect(e.fake.fetchLog.filter((f) => f.kind === 'upload-chunk').map((f) => f.bytes)).toEqual([8 * MiB, 8 * MiB, data.length - 16 * MiB]);
    expect(progress[0]).toEqual([0, data.length]);
    expect(progress.at(-1)).toEqual([data.length, data.length]);
    expect(monotonic(progress.map((p) => p[0]))).toBe(true);
    expect(e.fake.uploaded()).toHaveLength(1);
  });

  it('チャンク境界ちょうど（8 MiB）は 1 チャンク', async () => {
    const e = makeEnv();
    const data = randomBytes(8 * MiB, 10);
    const res = await e.transfer.uploadToDrive('root', 'exact.mp3', new Blob([data]));
    const node = e.fake.nodes.get(res.id);
    expect(node.mimeType).toBe('audio/mpeg');
    expect(node.parents).toEqual(['root'.replace('root', e.fake.rootId)]);
    expect(same(node.content, data)).toBe(true);
    expect(e.fake.fetchLog.filter((f) => f.kind === 'upload-chunk')).toHaveLength(1);
  });

  it('小さい Blob・1 バイト・チャンク境界の前後（256 KiB チャンク）。拡張子ごとの MIME', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const exts = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', mp4: 'video/mp4' };
    const sizes = [1, 7, KB256 - 1, KB256, KB256 + 1, 2 * KB256, 2 * KB256 + 1, 3 * KB256];
    let i = 0;
    for (const size of sizes) {
      const ext = Object.keys(exts)[i++ % Object.keys(exts).length];
      const data = randomBytes(size, size + 1);
      const res = await e.transfer.uploadToDrive(e.ids.music, `s${size}.${ext}`, new Blob([data]));
      const node = e.fake.nodes.get(res.id);
      expect(same(node.content, data), `size=${size}`).toBe(true);
      expect(node.mimeType, `size=${size}`).toBe(exts[ext]);
      expect(e.fake.sessions.get([...e.fake.sessions.keys()].at(-1)).chunkPuts, `size=${size}`).toBe(Math.ceil(size / KB256));
    }
  });

  it('ダウンロードしたファイルをそのままアップロードして往復させると一致する（名前・MIME も）', async () => {
    const e = makeEnv({ server: { chunkUnits: 4 } });
    const data = randomBytes(3 * MiB + 777, 31);
    const src = e.fake.addFile('往復.m4a', 'application/octet-stream', data, e.fake.rootId);
    const file = await e.transfer.downloadDriveFile(src.id);
    const res = await e.transfer.uploadToDrive(e.ids.work, file.name, file);
    const node = e.fake.nodes.get(res.id);
    expect(res.name).toBe('往復.m4a');
    expect(node.mimeType).toBe('audio/mp4');
    expect(same(node.content, data)).toBe(true);
  });

  it('保存先に書き込めない（閲覧専用フォルダ）: サーバーの日本語メッセージで失敗し、再試行しない。セッションも残らない', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const err = await e.transfer.uploadToDrive(e.ids.readonly, 'a.m4a', new Blob([randomBytes(10)])).catch((x) => x);
    expect(err.message).toBe('保存先のフォルダに書き込む権限がありません。');
    expect(e.g.count('beginUpload')).toBe(1);
    expect(e.fake.cacheKeys()).toEqual([]);
  });

  it('対応していない拡張子・仮想フォルダ・空の Blob はサーバーが断り、画面側は再試行せずそのメッセージを出す', async () => {
    const e = makeEnv();
    const blob = new Blob([randomBytes(10)]);
    expect((await e.transfer.uploadToDrive(e.ids.music, 'a.txt', blob).catch((x) => x)).message).toMatch(/音声・動画ファイルだけ/);
    expect((await e.transfer.uploadToDrive('starred', 'a.m4a', blob).catch((x) => x)).message).toMatch(/フォルダを指定/);
    const empty = await e.transfer.uploadToDrive(e.ids.music, 'a.m4a', new Blob([])).catch((x) => x);
    expect(empty.message).toMatch(/size/);
    expect(e.g.count('beginUpload')).toBe(3);
    expect(e.fake.fetchLog).toEqual([]);
  });

  it('150 文字を超える長い名前でも、拡張子が切れずに保存できる（サーバーが拡張子を残して切り詰める）', async () => {
    const e = makeEnv();
    const long = 'あ'.repeat(200) + '.m4a';
    const res = await e.transfer.uploadToDrive(e.ids.music, long, new Blob([randomBytes(10)]));
    expect(res.name).toHaveLength(150);
    expect(res.name.endsWith('.m4a')).toBe(true);
    expect(e.fake.nodes.get(res.id).mimeType).toBe('audio/mp4');
  });

  it('名前に使えない文字は無害化され、保存された名前が戻り値で分かる', async () => {
    const e = makeEnv();
    const res = await e.transfer.uploadToDrive(e.ids.music, 'a/b:c.mp3', new Blob([randomBytes(10)]));
    expect(res.name).toBe('a_b_c.mp3');
    expect(e.fake.nodes.get(res.id).name).toBe('a_b_c.mp3');
  });

  // ---- 失敗と再送
  const blobOf = (size, seed) => { const data = randomBytes(size, seed); return { data, blob: new Blob([data]) }; };
  const expectOneFile = (e, data, name = 'r.m4a') => {
    const ups = e.fake.uploaded();
    expect(ups).toHaveLength(1);
    expect(ups[0].name).toBe(name);
    expect(same(ups[0].content, data)).toBe(true);
    expect([...e.fake.sessions.values()].filter((s) => s.cancelled)).toHaveLength(0);
  };

  it('チャンクの送信が一時的に 500 を返す（Drive は保存していない）→ 画面側が再試行して完了する', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const { data, blob } = blobOf(4 * KB256 + 99, 41);
    e.fake.faults.push({ kind: 'upload-chunk', status: 500, times: 2, skip: 1 });
    await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expectOneFile(e, data);
    expect(e.g.count('uploadChunk')).toBeGreaterThan(5);
  });

  it('429 も同様（開始の 429 も再試行される）', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const { data, blob } = blobOf(2 * KB256, 42);
    e.fake.faults.push({ kind: 'upload-begin', status: 429, times: 1 }, { kind: 'upload-chunk', status: 429, times: 1 });
    await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expectOneFile(e, data);
    expect(e.g.count('beginUpload')).toBe(2);
    expect(e.fake.sessions.size).toBe(1);
  });

  it('Drive は保存したが応答が 500 だった → 再送で状態を問い合わせ、先へ進んで完了する（ファイルは壊れない）', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const { data, blob } = blobOf(4 * KB256 + 99, 43);
    e.fake.faults.push({ kind: 'upload-chunk', afterStore: true, status: 500, times: 1, skip: 1 });
    await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expectOneFile(e, data);
    expect([...e.fake.sessions.values()][0].statusQueries).toBeGreaterThanOrEqual(1);
  });

  for (const overlap of ['reject', 'accept']) {
    it(`Drive は保存したがサーバーの UrlFetchApp が例外（タイムアウト）→ 画面側の再送で完了する（重なる PUT を Drive が ${overlap === 'reject' ? '拒否する' : '受け入れる'}場合）`, async () => {
      const e = makeEnv({ server: { chunkUnits: 1 }, fake: { overlap } });
      const { data, blob } = blobOf(4 * KB256 + 99, 44);
      e.fake.faults.push({ kind: 'upload-chunk', throwAfter: true, times: 1, skip: 1 });
      await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
      expectOneFile(e, data);
    });

    it(`最後のチャンクを Drive が保存したがサーバーの UrlFetchApp が例外 → 再送で完了し、ファイルは 1 つだけ（${overlap}）`, async () => {
      const e = makeEnv({ server: { chunkUnits: 1 }, fake: { overlap } });
      const { data, blob } = blobOf(3 * KB256 + 99, 45);
      e.fake.faults.push({ kind: 'upload-chunk', throwAfter: true, times: 1, skip: 3 });
      await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
      expectOneFile(e, data);
    });
  }

  it('サーバーは途中のチャンクを受理したが google.script.run の応答が失われた → 再送で next から続き、完了する', async () => {
    let lost = false;
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'uploadChunk' && index === 2 && !lost) { lost = true; return 'drop-response'; } },
    });
    const { data, blob } = blobOf(4 * KB256 + 99, 46);
    await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expect(lost).toBe(true);
    expectOneFile(e, data);
  });

  it('サーバーは最後のチャンクを受理し完了したが応答が失われた → 再送で「完了」が返り、ファイルは 1 つだけ', async () => {
    let lost = false;
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'uploadChunk' && index === 4 && !lost) { lost = true; return 'drop-response'; } },
    });
    const { data, blob } = blobOf(3 * KB256 + 99, 47);
    const res = await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expect(lost).toBe(true);
    expect(res.name).toBe('r.m4a');
    expectOneFile(e, data);
  });

  it('要求が届かなかった（drop-request）チャンクも再送で完了する', async () => {
    let dropped = 0;
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'uploadChunk' && index === 2 && dropped++ === 0) return 'drop-request'; },
    });
    const { data, blob } = blobOf(3 * KB256 + 1, 48);
    await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expectOneFile(e, data);
  });

  it('beginUpload の応答が失われて再試行されると、最初のセッションは孤児になる（Drive にファイルは増えない。取り消されず、キャッシュに残る）', async () => {
    let lost = false;
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn }) => { if (fn === 'beginUpload' && !lost) { lost = true; return 'drop-response'; } },
    });
    const { data, blob } = blobOf(2 * KB256, 49);
    await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob);
    expectOneFile(e, data); // Drive のファイルは 1 つだけ
    const sessions = [...e.fake.sessions.values()];
    expect(sessions).toHaveLength(2);
    const orphan = sessions.find((s) => !s.done);
    expect(orphan).toMatchObject({ received: 0, cancelled: false });
    // サーバーのキャッシュに、孤児のセッション（Drive のセッション URL つき）が残る。完了した方は「完了済み」の印だけ
    const entries = e.fake.cacheKeys().map((k) => JSON.parse(e.fake.cache.get(k)));
    expect(entries.filter((x) => x.url)).toHaveLength(1);
    expect(entries.filter((x) => x.done)).toHaveLength(1);
  });

  it('セッションが期限切れ（キャッシュが消えた）: 再試行せず、サーバーのメッセージで失敗する。部分的なファイルは残らない', async () => {
    const e = makeEnv({
      server: { chunkUnits: 1 },
      hook: ({ fn, index }) => { if (fn === 'uploadChunk' && index === 2) e.fake.cache.clear(); },
    });
    const { blob } = blobOf(4 * KB256, 50);
    const err = await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob).catch((x) => x);
    expect(err.message).toMatch(/セッションが見つかりません/);
    expect(e.g.count('uploadChunk')).toBe(2);
    expect(e.fake.uploaded()).toEqual([]);
  });

  it('ガードが無効: 保存が DRIVE_DISABLED で失敗し、再試行せず、Drive にも触れない', async () => {
    const e = makeEnv({ fake: { active: 'visitor@example.test' } });
    const err = await e.transfer.uploadToDrive(e.ids.music, 'a.m4a', new Blob([randomBytes(10)])).catch((x) => x);
    expect(err.code).toBe('DRIVE_DISABLED');
    expect(e.g.names()).toEqual(['beginUpload']);
    expect(e.fake.fetchLog).toEqual([]);
  });

  it('中断: アップロードの途中で abort すると AbortError で終わり、abortUpload がサーバーに届いてセッションが消える。Drive にファイルは残らない', async () => {
    const ac = new AbortController();
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const { blob } = blobOf(4 * KB256, 51);
    const err = await e.transfer.uploadToDrive(e.ids.music, 'r.m4a', blob, { signal: ac.signal, onProgress: (sent) => { if (sent >= KB256) ac.abort(); } }).catch((x) => x);
    expect(err.name).toBe('AbortError');
    expect(e.g.count('abortUpload')).toBe(1);
    expect(e.fake.cacheKeys()).toEqual([]);
    const s = [...e.fake.sessions.values()][0];
    expect(s.cancelled).toBe(true);
    expect(s.chunkPuts).toBe(1);
    expect(e.fake.fetchLog.some((f) => f.kind === 'upload-delete')).toBe(true);
    expect(e.fake.uploaded()).toEqual([]); // 再開可能アップロードは、最後のチャンクが届くまで Drive にファイルを作らない
  });
});

describe('Drive 連携が使えるかの判定（checkDriveEnabled ↔ getDriveStatus）', () => {
  it('有効: true', async () => {
    const e = makeEnv();
    expect(await checkDriveEnabled({ gas: e.g.call, available: () => true })).toBe(true);
  });

  it('アクセスユーザーが違う / 実効ユーザーが空 / 焼き込みで無効: false', async () => {
    for (const [fake, server] of [[{ active: 'visitor@example.test' }, {}], [{ effective: null }, {}], [{ active: null }, {}], [{}, { driveEnabled: false }]]) {
      const e = makeEnv({ fake, server });
      expect(await checkDriveEnabled({ gas: e.g.call, available: () => true }), JSON.stringify([fake, server])).toBe(false);
      expect(await e.g.call('getDriveStatus')).toMatchObject({ enabled: false });
    }
  });

  it('ガードが無効のとき、画面側が呼ぶ各サーバー関数が DRIVE_DISABLED を返し、再試行されない形（retryable なし）', async () => {
    const e = makeEnv({ fake: { active: 'visitor@example.test' } });
    const calls = [['listFolder', 'root'], ['getFolderPath', 'root'], ['searchDrive', 'a'], ['resolveLocationInput', 'root'], ['createFolder', 'root', 'x'], ['getFileInfo', e.ids.rec], ['getFileChunk', e.ids.rec, 0, 10], ['beginUpload', { folderId: 'root', name: 'a.m4a', size: 1 }], ['uploadChunk', 'FAKE-TOKEN-0123456789', 0, 'AAAA', 3], ['abortUpload', 'FAKE-TOKEN-0123456789']];
    for (const [fn, ...args] of calls) {
      const r = await e.g.call(fn, ...args);
      expect(r, fn).toEqual({ error: 'この配信設定では Google ドライブ連携は使えません。', code: 'DRIVE_DISABLED' });
    }
    expect(e.fake.fetchLog).toEqual([]);
  });
});
