// 突き合わせテスト（一覧・場所・保存前の重複回避・契約に無い点の事実確認）。
// サーバーの実際の戻り値（本物の gas/Code.gs。JSON 往復後）を、src/lib/driveTypes.ts の型を実行時に検査する関数と、
// 画面側の純粋関数（src/lib/drivePlaces.ts・driveTransfer.ts）に通す。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { expectNoSerializationViolations, makeEnv, same } from './helpers/contract-env.mjs';
import { FOLDER_MIME, KB256, SOURCE, randomBytes } from './helpers/fake-drive.mjs';
import * as S from './helpers/shapes.mjs';
import { PLACES, buildCrumbs, classifyInput, folderUrl, isVirtualId, kindOf, placeFor, placeLabel, placeOf, rowKey } from '../src/lib/drivePlaces.ts';
import { EXT_MIME, mimeFromName, uniqueName } from '../src/lib/driveTransfer.ts';
import { scanIllegal } from './helpers/fake-run.mjs';

expectNoSerializationViolations();

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const names = (r) => r.items.map((i) => i.name);
const ok = (errs) => expect(errs).toEqual([]);

describe('検査関数そのものが働く（空振りしない）', () => {
  it('余計なキー・足りないキー・型違い・undefined・null の扱いを検出する', () => {
    const item = { id: 'a', name: 'n', type: 'file', mimeType: 'audio/mpeg', size: null, updated: null, canDownload: true };
    ok(S.driveItem(item));
    expect(S.driveItem({ ...item, extra: 1 }).join()).toMatch(/余計なキー/);
    expect(S.driveItem({ ...item, size: undefined }).join()).toMatch(/undefined|型が違う/);
    expect(S.driveItem({ ...item, size: '1' }).join()).toMatch(/型が違う/);
    expect(S.driveItem({ ...item, canAddChildren: true }).join()).toMatch(/ファイルに canAddChildren/);
    expect(S.driveItem({ ...item, type: 'folder' }).join()).toMatch(/canAddChildren が無い/);
    expect(S.driveItem({ ...item, driveId: null }).join()).toMatch(/型が違う/);
    expect(S.driveFolder({ id: 'a', name: 'n', parentId: null, isRoot: true, driveId: null }).join()).toMatch(/canAddChildren: キーが無い/);
    expect(S.uploadChunkResult({ success: true, done: true, next: 3 }).join()).toMatch(/file/);
  });
});

describe('一覧系の戻り値が型どおり（driveTypes.ts）', () => {
  it('listFolder: マイドライブのルート（root / 実 ID / 空）・実フォルダ・入れ子・閲覧専用・共有ドライブ・ショートカット', async () => {
    const e = makeEnv();
    const root = await e.g.call('listFolder', 'root');
    ok(S.listFolderResult(root));
    expect(root.folder).toEqual({ id: e.fake.rootId, name: 'マイドライブ', parentId: null, isRoot: true, driveId: null, canAddChildren: true });
    expect(names(root)).toEqual(expect.arrayContaining(['音楽', '仕事', '閲覧専用', '仕事への近道', 'rec-a.m4a', 'memo.mp3', 'octet.m4a', 'clip.mp4', 'locked.mp3', 'empty.mp3', '録音への近道.m4a']));
    // 音声・動画以外・ショートカットのショートカットは出ない
    for (const hidden of ['doc.pdf', 'data.txt', 'メモ', 'PDF への近道', '近道への近道']) expect(names(root)).not.toContain(hidden);
    expect(root.items.find((i) => i.name === 'locked.mp3').canDownload).toBe(false);
    expect(root.items.find((i) => i.name === '閲覧専用')).toMatchObject({ type: 'folder', canAddChildren: false });
    expect(root.items.find((i) => i.name === '録音への近道.m4a')).toMatchObject({ id: e.ids.rec, shortcut: true, size: null, type: 'file' });
    expect(root.items.find((i) => i.name === '仕事への近道')).toMatchObject({ id: e.ids.work, shortcut: true, type: 'folder', canAddChildren: false });
    // フォルダが先
    const firstFile = root.items.findIndex((i) => i.type === 'file');
    expect(root.items.slice(0, firstFile).every((i) => i.type === 'folder')).toBe(true);
    expect(root.items.slice(firstFile).every((i) => i.type === 'file')).toBe(true);

    for (const id of [e.fake.rootId, '', null]) {
      const r = await e.g.call('listFolder', id);
      ok(S.listFolderResult(r));
      expect(r.folder.id).toBe(e.fake.rootId);
    }
    const nested = await e.g.call('listFolder', e.ids.work2026);
    ok(S.listFolderResult(nested));
    expect(nested.folder).toMatchObject({ id: e.ids.work2026, name: '2026', parentId: e.ids.work, isRoot: false, driveId: null, canAddChildren: true });
    expect(names(nested)).toEqual(['nested.wav']);
    const ro = await e.g.call('listFolder', e.ids.readonly);
    ok(S.listFolderResult(ro));
    expect(ro.folder.canAddChildren).toBe(false);
    expect(ro.items).toEqual([]);
  });

  it('listFolder: 共有ドライブのルート・共有ドライブの中・仮想フォルダ（共有アイテム・スター付き・最近使ったもの）', async () => {
    const e = makeEnv();
    const sr = await e.g.call('listFolder', 'shared-root');
    ok(S.listFolderResult(sr));
    expect(sr.folder).toEqual({ id: 'shared-root', name: '共有ドライブ', parentId: null, isRoot: true, driveId: null, canAddChildren: false });
    expect(names(sr).sort()).toEqual(['共有ドライブ乙', '共有ドライブ甲'].sort());
    expect(sr.items.find((i) => i.name === '共有ドライブ乙')).toMatchObject({ type: 'folder', canAddChildren: false, driveId: e.ids.sharedDrive2, id: e.ids.sharedDrive2 });
    const sdRoot = await e.g.call('listFolder', e.ids.sharedDrive);
    ok(S.listFolderResult(sdRoot));
    expect(sdRoot.folder).toEqual({ id: e.ids.sharedDrive, name: '共有ドライブ甲', parentId: null, isRoot: true, driveId: e.ids.sharedDrive, canAddChildren: true });
    expect(names(sdRoot)).toEqual(['会議']);
    const sdFolder = await e.g.call('listFolder', e.ids.sdFolder);
    ok(S.listFolderResult(sdFolder));
    expect(sdFolder.folder).toMatchObject({ parentId: e.ids.sharedDrive, isRoot: false, driveId: e.ids.sharedDrive });
    expect(sdFolder.items[0]).toMatchObject({ name: '会議.m4a', driveId: e.ids.sharedDrive });

    for (const [id, label, expected] of [
      ['shared-with-me', '共有アイテム', ['共有された.mp3', '共有されたフォルダ']],
      ['starred', 'スター付き', ['star.mp3']],
      ['recent', '最近使ったもの', ['viewed2.mp3', 'viewed.mp3']],
    ]) {
      const r = await e.g.call('listFolder', id);
      ok(S.listFolderResult(r));
      expect(r.folder).toEqual({ id, name: label, parentId: null, isRoot: true, driveId: null, canAddChildren: false });
      expect(names(r), id).toEqual(id === 'shared-with-me' ? expect.arrayContaining(expected) : expected);
    }
    // 共有アイテム: 親をたどれないフォルダも開ける
    const sf = await e.g.call('listFolder', e.ids.sharedFolder);
    ok(S.listFolderResult(sf));
    expect(sf.folder).toMatchObject({ parentId: null, isRoot: false, canAddChildren: false });
  });

  it('listFolder の foldersOnly: どの場所でもフォルダ（とフォルダへのショートカット）だけ。null / 未指定も受け付ける', async () => {
    const e = makeEnv();
    for (const id of ['root', e.ids.work, 'shared-root', 'shared-with-me', 'starred', 'recent', e.ids.sdFolder]) {
      const r = await e.g.call('listFolder', id, { foldersOnly: true });
      ok(S.listFolderResult(r));
      expect(r.items.every((i) => i.type === 'folder'), id).toBe(true);
    }
    expect(names(await e.g.call('listFolder', 'root', { foldersOnly: true }))).toEqual(expect.arrayContaining(['音楽', '仕事', '閲覧専用', '仕事への近道']));
    for (const opt of [null, {}]) ok(S.listFolderResult(await e.g.call('listFolder', 'root', opt)));
    ok(S.listFolderResult(await e.g.call('listFolder', 'root')));
  });

  it('画面側の gasCall は、引数の undefined を落とす・null にするので、サーバーに undefined が渡らない（listFolder の第 2 引数・searchDrive の第 2 引数）。サーバーは省略・null・{} を受け付ける', async () => {
    const e = makeEnv();
    for (const call of [
      () => e.g.call('listFolder', 'root', undefined), // 読み込みモードの DriveModal が以前渡していた形
      () => e.g.call('listFolder', 'root', {}),
      () => e.g.call('listFolder', 'root', null),
    ]) {
      const r = await call();
      ok(S.listFolderResult(r));
      expect(r.items.some((i) => i.type === 'file')).toBe(true);
    }
    ok(S.searchResult(await e.g.call('searchDrive', '会議', undefined)));
    ok(S.searchResult(await e.g.call('searchDrive', '会議', {})));
    // サーバーに届いた引数に undefined は無い（偽の google.script.run は undefined の引数を違反として記録する。afterEach で 0 件を確認）
    expect(e.g.log.filter((l) => l.fn === 'listFolder').map((l) => l.args)).toEqual(['["root"]', '["root",{}]', '["root",null]']);
    expect(e.g.violations).toEqual([]);
  });

  it('偽の google.script.run の検査器は、生の undefined の引数を違反として検出する（gasCall を通さなければ違反になる）', async () => {
    const e = makeEnv();
    const raw = await new Promise((resolve, reject) => e.g.run.withSuccessHandler(resolve).withFailureHandler(reject).listFolder('root', undefined));
    ok(S.listFolderResult(raw));
    expect(e.g.violations).toEqual([{ where: 'args', fn: 'listFolder', path: 'args[1]', kind: 'undefined' }]);
    e.g.violations.length = 0; // この 1 件は意図したもの
    expect(scanIllegal(['a', undefined, { b: undefined }], 'args').map((v) => v.path)).toEqual(['args[1]', 'args[2].b']);
  });

  it('src の gasCall / call の呼び出しに、引数として undefined を直に書いていない（正規化に頼らない）', () => {
    for (const f of ['App.tsx', 'components/DriveModal.tsx', 'lib/driveTransfer.ts', 'lib/driveStatus.ts']) {
      const text = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
      for (const m of text.matchAll(/(?:gasCall|gas)(?:<[^>]*>)?\(([^)]*)\)/g)) expect(m[1], `${f}: ${m[0]}`).not.toMatch(/\bundefined\b/);
    }
    expect(fs.readFileSync(path.join(SRC_DIR, 'components/DriveModal.tsx'), 'utf8')).not.toMatch(/\? \{ foldersOnly: true \} : undefined/);
  });

  it('listFolder: 項目が多いとき（5001 件）は 5000 件で truncated: true。ページングを最後まで辿る', async () => {
    const e = makeEnv();
    const big = e.fake.addFolder('大量', e.fake.rootId, { id: 'FAKEFOLDER-BIG-00001' });
    for (let i = 0; i < 5001; i++) e.fake.addFile(`f${String(i).padStart(5, '0')}.mp3`, 'audio/mpeg', 'x', big.id);
    const r = await e.g.call('listFolder', big.id);
    ok(S.listFolderResult(r));
    expect(r.items).toHaveLength(5000);
    expect(r.truncated).toBe(true);
    expect(r.items[0].name).toBe('f00000.mp3');
    // ちょうど 5000 件なら truncated は付かない
    const exact = e.fake.addFolder('ちょうど', e.fake.rootId, { id: 'FAKEFOLDER-EXACT-0001' });
    for (let i = 0; i < 5000; i++) e.fake.addFile(`g${String(i).padStart(5, '0')}.mp3`, 'audio/mpeg', 'x', exact.id);
    const r2 = await e.g.call('listFolder', exact.id);
    expect(r2.items).toHaveLength(5000);
    expect(r2.truncated).toBeUndefined();
  });

  it('listFolder: 不正な ID・仮想でも実でもない ID は GasError（retryable なし）', async () => {
    const e = makeEnv();
    for (const id of ['short', "x' or '1'='1", 'FAKENOSUCHFOLDER-0001']) {
      const r = await e.g.call('listFolder', id);
      ok(S.isGasErrorShape(r));
      expect(r.retryable).toBeUndefined();
    }
  });

  it('searchDrive: 型どおり。共有ドライブの中も探す。foldersOnly。truncated は boolean で必ず付く', async () => {
    const e = makeEnv();
    const r = await e.g.call('searchDrive', '会議');
    ok(S.searchResult(r));
    expect(r.query).toBe('会議');
    expect(names(r).sort()).toEqual(['会議', '会議.m4a'].sort());
    expect(r.truncated).toBe(false);
    const m4a = await e.g.call('searchDrive', 'm4a');
    ok(S.searchResult(m4a));
    expect(names(m4a)).toEqual(expect.arrayContaining(['rec-a.m4a', 'octet.m4a', '録音への近道.m4a', '共有フォルダ内.m4a', '会議.m4a']));
    const f = await e.g.call('searchDrive', '会議', { foldersOnly: true });
    ok(S.searchResult(f));
    expect(names(f)).toEqual(['会議']);
    ok(S.isGasErrorShape(await e.g.call('searchDrive', '   ')));
  });

  it('getFolderPath: 型どおり。マイドライブは root から、共有ドライブはドライブのルートから、仮想フォルダは 1 要素', async () => {
    const e = makeEnv();
    const p = async (id) => { const r = await e.g.call('getFolderPath', id); ok(S.folderPathResult(r)); return r.path; };
    expect(await p('root')).toEqual([{ id: 'root', name: 'マイドライブ' }]);
    expect(await p(e.fake.rootId)).toEqual([{ id: 'root', name: 'マイドライブ' }]);
    expect(await p(e.ids.work2026)).toEqual([{ id: 'root', name: 'マイドライブ' }, { id: e.ids.work, name: '仕事' }, { id: e.ids.work2026, name: '2026' }]);
    expect(await p(e.ids.sdFolder)).toEqual([{ id: e.ids.sharedDrive, name: '共有ドライブ甲' }, { id: e.ids.sdFolder, name: '会議' }]);
    expect(await p(e.ids.sharedDrive)).toEqual([{ id: e.ids.sharedDrive, name: '共有ドライブ甲' }]);
    expect(await p(e.ids.sharedFolder)).toEqual([{ id: e.ids.sharedFolder, name: '共有されたフォルダ' }]);
    expect(await p('starred')).toEqual([{ id: 'starred', name: 'スター付き' }]);
  });

  it('resolveLocationInput: フォルダ・ファイル・ショートカット・URL 形式・ID 形式。型どおりで、音声・動画以外のファイルは返さない', async () => {
    const e = makeEnv();
    const r = async (text) => { const x = await e.g.call('resolveLocationInput', text); ok(x.error ? [] : S.resolveResult(x)); return x; };
    const fid = (id) => `https://drive.google.com/drive/folders/${id}?usp=sharing`;
    expect(await r(fid(e.ids.music))).toEqual({ kind: 'folder', id: e.ids.music, name: '音楽' });
    expect(await r(`https://drive.google.com/drive/u/0/folders/${e.ids.music}`)).toEqual({ kind: 'folder', id: e.ids.music, name: '音楽' });
    expect(await r(e.ids.music)).toMatchObject({ kind: 'folder' });
    expect(await r('root')).toEqual({ kind: 'folder', id: e.fake.rootId, name: 'マイドライブ' });
    expect(await r(e.ids.sharedDrive)).toEqual({ kind: 'folder', id: e.ids.sharedDrive, name: '共有ドライブ甲' });
    const file = await r(`https://drive.google.com/file/d/${e.ids.rec}/view?usp=sharing`);
    expect(file).toMatchObject({ kind: 'file', parentId: e.fake.rootId, item: { id: e.ids.rec, name: 'rec-a.m4a', canDownload: true } });
    expect(await r(`https://drive.google.com/open?id=${e.ids.octet}`)).toMatchObject({ kind: 'file', item: { name: 'octet.m4a', mimeType: 'application/octet-stream' } });
    expect(await r(e.ids.scFolder)).toEqual({ kind: 'folder', id: e.ids.work, name: '仕事' });
    expect(await r(e.ids.scAudio)).toMatchObject({ kind: 'file', item: { id: e.ids.rec } });
    expect(await r(e.ids.locked)).toMatchObject({ kind: 'file', item: { canDownload: false } });
    expect(await r(e.ids.sharedFile)).toMatchObject({ kind: 'file', parentId: null }); // 親が分からない共有ファイル
    // 音声・動画でないもの・ショートカットの連鎖・存在しないもの・読めない入力は GasError
    for (const bad of [e.ids.pdf, e.ids.gdoc, e.ids.octetTxt, e.ids.scPdf, e.ids.scShortcut, 'FAKENOSUCHFILE-00001', '', 'hello', 'https://example.test/']) {
      const x = await e.g.call('resolveLocationInput', bad);
      ok(S.isGasErrorShape(x));
    }
    // 全ノードに対して: ファイルとして返るものは、必ず音声・動画（または拡張子つきの octet-stream）
    for (const n of e.fake.nodes.values()) {
      if (n.isMyDriveRoot || !/^[-\w]{10,200}$/.test(n.id)) continue;
      const x = await e.g.call('resolveLocationInput', n.id);
      if (x.error) continue;
      ok(S.resolveResult(x));
      if (x.kind === 'file') expect(x.item.mimeType.startsWith('audio/') || x.item.mimeType.startsWith('video/') || /\.(m4a|mp3|wav)$/.test(x.item.name)).toBe(true);
    }
  });

  it('createFolder: 型どおり。作ったフォルダを listFolder で開ける（保存先にできる）。閲覧専用・仮想フォルダ・空の名前は GasError', async () => {
    const e = makeEnv();
    for (const parent of ['root', e.ids.work, e.ids.sdFolder, e.ids.sharedDrive]) {
      const c = await e.g.call('createFolder', parent, '  新規/フォルダ  ');
      ok(S.createFolderResult(c));
      expect(c.name).toBe('新規_フォルダ');
      const opened = await e.g.call('listFolder', c.id);
      ok(S.listFolderResult(opened));
      expect(opened.folder).toMatchObject({ id: c.id, name: '新規_フォルダ', canAddChildren: true, isRoot: false });
      expect(opened.items).toEqual([]);
    }
    for (const [parent, name] of [[e.ids.readonly, 'x'], ['starred', 'x'], ['recent', 'x'], ['root', '  ']]) ok(S.isGasErrorShape(await e.g.call('createFolder', parent, name)));
  });

  it('getFileInfo / getFileChunk / beginUpload / uploadChunk / abortUpload / getDriveStatus の戻り値が型どおり', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    ok(S.driveStatus(await e.g.call('getDriveStatus')));
    const info = await e.g.call('getFileInfo', e.ids.rec);
    ok(S.fileInfoResult(info));
    expect(info).toMatchObject({ id: e.ids.rec, name: 'rec-a.m4a', size: 10, mimeType: 'audio/mp4', parentId: e.fake.rootId, chunkSize: KB256 });
    ok(S.fileInfoResult(await e.g.call('getFileInfo', e.ids.scAudio)));
    ok(S.fileInfoResult(await e.g.call('getFileInfo', e.ids.sharedFile))); // parentId は null
    expect((await e.g.call('getFileInfo', e.ids.sharedFile)).parentId).toBeNull();
    const c = await e.g.call('getFileChunk', e.ids.rec, 0, 4);
    ok(S.fileChunkResult(c));
    expect(Buffer.from(c.data, 'base64').toString()).toBe('AAAA');
    const eof = await e.g.call('getFileChunk', e.ids.rec, 100, 4);
    ok(S.fileChunkResult(eof));
    expect(eof).toMatchObject({ length: 0, data: '', etag: null });
    const b = await e.g.call('beginUpload', { folderId: e.ids.music, name: 'u.m4a', size: KB256 + 5 });
    ok(S.beginUploadResult(b));
    const u1 = await e.g.call('uploadChunk', b.token, 0, randomBytes(KB256).toString('base64'), KB256 + 5);
    ok(S.uploadChunkResult(u1));
    expect(u1).toEqual({ success: true, done: false, next: KB256 });
    const u2 = await e.g.call('uploadChunk', b.token, KB256, randomBytes(5).toString('base64'), KB256 + 5);
    ok(S.uploadChunkResult(u2));
    expect(u2.done).toBe(true);
    const b2 = await e.g.call('beginUpload', { folderId: e.ids.music, name: 'u2.m4a', size: 10 });
    ok(S.abortUploadResult(await e.g.call('abortUpload', b2.token)));
    // エラーの形
    for (const bad of [await e.g.call('getFileInfo', e.ids.locked), await e.g.call('getFileInfo', e.ids.empty), await e.g.call('getFileInfo', e.ids.pdf), await e.g.call('getFileChunk', 'short', 0, 1), await e.g.call('beginUpload', null)]) ok(S.isGasErrorShape(bad));
  });
});

describe('場所（drivePlaces.ts）とサーバーの対応', () => {
  it('PLACES の ID は、サーバーの仮想フォルダ ID（と root）と過不足なく一致し、どれを listFolder に渡してもエラーにならない', async () => {
    const e = makeEnv();
    const ctx = e.server.newContext();
    const serverVirtual = vm.runInContext('Object.keys(DRIVE_VIRTUAL_NAMES_)', ctx).sort();
    expect(PLACES.map((p) => p.id).filter((id) => id !== 'root').sort()).toEqual(serverVirtual);
    expect(PLACES[0].id).toBe('root');
    for (const p of PLACES) {
      const r = await e.g.call('listFolder', p.id);
      expect(r.error, p.id).toBeUndefined();
      ok(S.listFolderResult(r));
      for (const foldersOnly of [true]) expect((await e.g.call('listFolder', p.id, { foldersOnly })).error).toBeUndefined();
    }
  });

  it('場所の表示名と、サーバーが返す folder.name / パンくずの名前が一致する（マイドライブのルートも日本語の「マイドライブ」）', async () => {
    const e = makeEnv();
    for (const p of PLACES) {
      expect((await e.g.call('listFolder', p.id)).folder.name, p.id).toBe(p.label);
      expect(placeLabel(p.id)).toBe(p.label);
    }
    // 実 ID でルートを開いても、パンくずでも、URL / ID の解決でも、同じ名前
    expect((await e.g.call('listFolder', e.fake.rootId)).folder.name).toBe('マイドライブ');
    expect((await e.g.call('getFolderPath', e.fake.rootId)).path[0].name).toBe('マイドライブ');
    expect((await e.g.call('resolveLocationInput', e.fake.rootId)).name).toBe('マイドライブ');
    // Drive 自身が返すルートの名前は英語（スタブも実物に合わせて 'My Drive'）なのに、サーバーが日本語にしている
    expect(e.fake.nodes.get(e.fake.rootId).name).toBe('My Drive');
    // 保存先の文言「Google ドライブの「<folder.name>」に N 個を保存しました」に出る名前
    expect((await e.g.call('listFolder', 'root')).folder.name).not.toMatch(/My Drive/);
  });

  it('isVirtualId はサーバーが「保存先にできない」と断る ID と一致する（仮想は拒否、root と実 ID は受理）', async () => {
    const e = makeEnv();
    for (const id of ['root', 'shared-root', 'shared-with-me', 'starred', 'recent', e.ids.music]) {
      const begun = await e.g.call('beginUpload', { folderId: id, name: 'a.m4a', size: 10 });
      const made = await e.g.call('createFolder', id, 'x');
      expect(!begun.error, `beginUpload(${id})`).toBe(!isVirtualId(id));
      expect(!made.error, `createFolder(${id})`).toBe(!isVirtualId(id));
    }
  });

  it('保存できるフォルダか（!isVirtualId && canAddChildren — DriveModal の canSave と同じ判定）が、サーバーが実際に保存を受け付けるかと一致する', async () => {
    const e = makeEnv();
    const saveable = (folder) => !isVirtualId(folder.id) && folder.canAddChildren === true;
    const targets = ['root', e.ids.music, e.ids.work2026, e.ids.readonly, e.ids.sdFolder, e.ids.sharedDrive, e.ids.sharedDrive2, e.ids.sharedFolder, 'shared-root', 'shared-with-me', 'starred', 'recent'];
    for (const id of targets) {
      const { folder } = await e.g.call('listFolder', id);
      const begun = await e.g.call('beginUpload', { folderId: folder.id, name: 'a.m4a', size: 10 });
      expect(!begun.error, `${id}: 判定=${saveable(folder)} サーバー=${begun.error ?? 'OK'}`).toBe(saveable(folder));
    }
  });

  it('選べるファイルか（type が file で canDownload）と、サーバーが開けるか（getFileInfo）の対応。空ファイルだけが「選べるのに開けない」', async () => {
    const e = makeEnv();
    const { items } = await e.g.call('listFolder', 'root');
    const mismatches = [];
    for (const it of items.filter((x) => x.type === 'file')) {
      const selectable = it.canDownload;
      const info = await e.g.call('getFileInfo', it.id);
      if (selectable !== !!info.success) mismatches.push([it.name, info.error]);
    }
    expect(mismatches).toEqual([['empty.mp3', 'ファイルのサイズを取得できません（空のファイル、または読み込めない形式です）。']]);
  });

  it('パンくず（buildCrumbs）と placeOf: サーバーの実際の folder と getFolderPath の結果から、期待どおりの表示になる', async () => {
    const e = makeEnv();
    const crumbsOf = async (id) => {
      const { folder } = await e.g.call('listFolder', id);
      const pr = id === 'shared-root' || isVirtualId(id) ? null : await e.g.call('getFolderPath', folder.id);
      return { folder, crumbs: buildCrumbs(folder, pr && pr.path) };
    };
    const view = (cs) => cs.map((c) => `${c.name}${c.current ? '*' : ''}`);
    expect(view((await crumbsOf('root')).crumbs)).toEqual(['マイドライブ*']);
    expect((await crumbsOf('root')).crumbs[0].id).toBe('root');
    expect(view((await crumbsOf(e.fake.rootId)).crumbs)).toEqual(['マイドライブ*']);
    expect(view((await crumbsOf(e.ids.work2026)).crumbs)).toEqual(['マイドライブ', '仕事', '2026*']);
    expect((await crumbsOf(e.ids.work2026)).crumbs.map((c) => c.id)).toEqual(['root', e.ids.work, e.ids.work2026]);
    expect(view((await crumbsOf(e.ids.sharedDrive)).crumbs)).toEqual(['共有ドライブ', '共有ドライブ甲*']);
    expect(view((await crumbsOf(e.ids.sdFolder)).crumbs)).toEqual(['共有ドライブ', '共有ドライブ甲', '会議*']);
    expect(view((await crumbsOf(e.ids.sharedFolder)).crumbs)).toEqual(['共有されたフォルダ*']); // 親をたどれない
    for (const p of PLACES.slice(1)) expect(view((await crumbsOf(p.id)).crumbs)).toEqual([`${p.label}*`]);
    // どのパンくずの ID も、そのまま listFolder に渡せる（クリックして移動できる）
    for (const id of ['root', e.ids.work2026, e.ids.sdFolder, e.ids.sharedDrive]) {
      for (const c of (await crumbsOf(id)).crumbs) expect((await e.g.call('listFolder', c.id)).error, `${id} の ${c.name}`).toBeUndefined();
    }
    // パンくずが取れなかった場合は表示中のフォルダ名だけ
    const { folder } = await e.g.call('listFolder', e.ids.work2026);
    expect(view(buildCrumbs(folder, null))).toEqual(['2026*']);

    // placeOf: 場所の強調表示
    const placeKey = async (id) => placeOf((await e.g.call('listFolder', id)).folder).key;
    expect(await placeKey('root')).toBe('my-drive');
    expect(await placeKey(e.ids.work2026)).toBe('my-drive');
    expect(await placeKey(e.ids.sdFolder)).toBe('shared-drives');
    expect(await placeKey(e.ids.sharedDrive)).toBe('shared-drives');
    for (const p of PLACES.slice(1)) expect(await placeKey(p.id)).toBe(p.key);
  });

  it('URL / ID の入力（classifyInput）: place はサーバーが開ける ID、drive はサーバーが解決できる', async () => {
    const e = makeEnv();
    for (const [text, id] of [['マイドライブ', 'root'], ['共有ドライブ', 'shared-root'], ['root', 'root'], ['https://drive.google.com/drive/u/1/shared-with-me', 'shared-with-me'], ['https://drive.google.com/drive/my-drive', 'root'], ['https://drive.google.com/drive/starred', 'starred'], ['https://drive.google.com/drive/recent', 'recent'], ['https://drive.google.com/drive/shared-drives', 'shared-root']]) {
      const c = classifyInput(text);
      expect(c, text).toEqual({ kind: 'place', id });
      expect((await e.g.call('listFolder', c.id)).error).toBeUndefined();
    }
    const longId = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'; // 実際の ID は 33 文字以上（ダミー）
    e.fake.addFile('long.m4a', 'audio/mp4', 'x', e.ids.music, { id: longId });
    for (const text of [`https://drive.google.com/drive/folders/${e.ids.music}?usp=sharing`, `https://drive.google.com/file/d/${e.ids.rec}/view`, `https://drive.google.com/open?id=${e.ids.octet}`, e.ids.music, longId]) {
      const c = classifyInput(text);
      expect(c.kind, text).toBe('drive');
      expect((await e.g.call('resolveLocationInput', c.text)).error, text).toBeUndefined();
    }
    expect(classifyInput('録音').kind).toBe('none');
    expect(folderUrl(e.ids.music)).toBe(`https://drive.google.com/drive/folders/${e.ids.music}`);
  });

  it('application/octet-stream の .m4a（サーバーは音声として一覧に出し、選べる）は、一覧のアイコン判定 kindOf で音声（audio）になる。一覧の全項目で、サーバーが出す種類と画面側の判定が合う', async () => {
    const e = makeEnv();
    const root = await e.g.call('listFolder', 'root');
    const octet = root.items.find((i) => i.name === 'octet.m4a');
    expect(octet.mimeType).toBe('application/octet-stream');
    expect(kindOf(octet)).toBe('audio');
    // サーバーが一覧に出すファイルは、すべて audio か video と判定される（「その他のファイル」にならない）
    for (const r of [root, await e.g.call('listFolder', 'shared-with-me'), await e.g.call('searchDrive', 'm4a')]) {
      for (const i of r.items.filter((x) => x.type === 'file')) expect(['audio', 'video'], i.name).toContain(kindOf(i));
    }
  });

  it('19 文字の共有ドライブ ID（実際の ID は 19 文字前後 — 要実機確認）を貼り付けると、classifyInput が ID として扱い、サーバーが解決する。検索語は検索のまま', async () => {
    const e = makeEnv();
    const dummyId = '0AFAKEDRIVEIDDUMMY1';
    expect(dummyId).toHaveLength(19);
    expect(/^[-\w]{10,200}$/.test(dummyId)).toBe(true); // サーバーは 10 文字以上の ID を受け付ける
    expect(classifyInput(dummyId)).toEqual({ kind: 'drive', text: dummyId });
    e.fake.addSharedDrive('共有ドライブ丙', { id: dummyId });
    const r = await e.g.call('resolveLocationInput', classifyInput(dummyId).text);
    expect(r).toMatchObject({ kind: 'folder', id: dummyId });
    for (const w of ['meeting_2024', 'kaigi-rokuon']) expect(classifyInput(w).kind, w).toBe('none');
  });

  it('画面側の rowKey / placeFor: ショートカットと本体（同じ ID）は別の行。共有アイテムの中のフォルダは入ってきた場所のまま', async () => {
    const e = makeEnv();
    const root = await e.g.call('listFolder', 'root');
    const rows = root.items.filter((i) => i.id === e.ids.rec);
    expect(rows.length).toBeGreaterThanOrEqual(2); // rec-a.m4a と 録音への近道.m4a
    expect(new Set(rows.map(rowKey)).size).toBe(rows.length);
    expect(new Set(root.items.map(rowKey)).size).toBe(root.items.length); // 一覧の全行でキーが重複しない
    const sf = (await e.g.call('listFolder', e.ids.sharedFolder)).folder;
    expect(placeOf(sf).key).toBe('my-drive'); // フォルダ自体の情報では区別できない
    expect(placeFor(sf, 'shared-with-me').key).toBe('shared-with-me');
  });

  it('拡張子の対応表: サーバー（Code.gs の DRIVE_EXT_MIME_）と画面側（driveTransfer.ts の EXT_MIME）で、拡張子の集合も MIME も一致する', () => {
    const server = makeEnv({ seed: false }).server.newContext().DRIVE_EXT_MIME_;
    expect(server && typeof server).toBe('object');
    const serverExts = Object.keys(server).sort();
    expect(serverExts.length).toBeGreaterThan(20);
    expect(Object.keys(EXT_MIME).sort()).toEqual(serverExts);
    for (const ext of serverExts) {
      expect(EXT_MIME[ext], ext).toBe(server[ext]);
      expect(mimeFromName(`a.${ext.toUpperCase()}`), ext).toBe(server[ext]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('保存前の重複回避の流れ（listFolder → uniqueName → uploadToDrive）', () => {
  /** App.tsx の startSave と同じ手順（保存先の listFolder で名前を集め、uniqueName で避け、uploadToDrive で保存する） */
  async function save(e, destId, parts) {
    const listed = await e.g.call('listFolder', destId);
    if (listed.error) throw new Error(listed.error);
    const taken = new Set(listed.items.map((i) => i.name));
    const saved = [];
    for (const p of parts) {
      const name = uniqueName(taken, p.fileName);
      taken.add(name);
      const res = await e.transfer.uploadToDrive(listed.folder.id, name, p.blob);
      saved.push(res.name);
    }
    return { saved, listed };
  }
  const part = (fileName, seed = 1) => ({ fileName, blob: new Blob([randomBytes(100, seed)]) });

  it('同名のファイルがあれば連番が付く。保存のたびに増え、既存の連番とも衝突しない。同名の音声・動画のショートカットも「ある」とみなす', async () => {
    const e = makeEnv();
    e.fake.addFile('out_001.m4a', 'audio/mp4', 'x', e.ids.music);
    e.fake.addFile('out_002 (1).m4a', 'application/octet-stream', 'x', e.ids.music); // octet-stream + 拡張子 → 一覧に出る
    const r1 = await save(e, e.ids.music, [part('out_001.m4a'), part('out_001.m4a'), part('out_002.m4a'), part('out_002 (1).m4a'), part('new.m4a')]);
    expect(r1.saved).toEqual(['out_001 (1).m4a', 'out_001 (2).m4a', 'out_002.m4a', 'out_002 (2).m4a', 'new.m4a']);
    // もう一度同じ名前で保存すると、さらに先の連番
    const r2 = await save(e, e.ids.music, [part('out_001.m4a')]);
    expect(r2.saved).toEqual(['out_001 (3).m4a']);
    // マイドライブ直下（実 ID）でも同じ。ショートカットの名前も衝突として扱う（録音への近道.m4a）
    const r3 = await save(e, 'root', [part('録音への近道.m4a'), part('rec-a.m4a')]);
    expect(r3.saved).toEqual(['録音への近道 (1).m4a', 'rec-a (1).m4a']);
  });

  it('【事実】同名のファイルが「音声・動画以外」（一覧に出ない MIME）だと重複を見逃し、Drive に同名のファイルが 2 つできる', async () => {
    const e = makeEnv();
    e.fake.addFile('out_001.m4a', 'application/zip', 'x', e.ids.music, { id: 'FAKEFILE-HIDDEN-0001' });
    const { saved, listed } = await save(e, e.ids.music, [part('out_001.m4a')]);
    expect(names(listed)).not.toContain('out_001.m4a');
    expect(saved).toEqual(['out_001.m4a']); // 連番が付かない
    expect(e.fake.filesNamed('out_001.m4a')).toHaveLength(2);
  });

  it('【事実】フォルダ内が 5000 件を超えて truncated になると、後ろの名前を見逃して重複が起きる（画面側は truncated を見て注意を出す。次のテスト）', async () => {
    const e = makeEnv();
    const big = e.fake.addFolder('大量', e.fake.rootId, { id: 'FAKEFOLDER-BIG-00001' });
    for (let i = 0; i < 5000; i++) e.fake.addFile(`f${String(i).padStart(5, '0')}.mp3`, 'audio/mpeg', 'x', big.id);
    e.fake.addFile('zzz-last.m4a', 'audio/mp4', 'x', big.id); // 名前順で最後 → 5000 件の外
    const { saved, listed } = await save(e, big.id, [part('zzz-last.m4a')]);
    expect(listed.truncated).toBe(true);
    expect(saved).toEqual(['zzz-last.m4a']);
    expect(e.fake.filesNamed('zzz-last.m4a')).toHaveLength(2);
  });

  it('【画面側】App.tsx の startSave は保存先の listFolder の truncated を見て、完了・中止・失敗のすべての表示（Results.tsx）に注意を添える。保存は止めない', () => {
    const app = fs.readFileSync(path.join(SRC_DIR, 'App.tsx'), 'utf8');
    const body = app.slice(app.indexOf('const startSave'), app.indexOf('const cancelSave'));
    expect(body).toMatch(/listed\.truncated/);
    expect(body).toMatch(/namesIncomplete = !!listed\.truncated;/); // 記録するだけ（truncated を理由に throw しない）
    expect((body.match(/namesIncomplete/g) || []).length).toBeGreaterThanOrEqual(4); // 宣言・done・aborted・error
    const results = fs.readFileSync(path.join(SRC_DIR, 'components/Results.tsx'), 'utf8');
    expect(results).toMatch(/data-testid="drive-save-truncated-note"/);
    expect((results.match(/<NamesIncompleteNote \/>/g) || []).length).toBe(2); // done と stopped（中止・失敗）
    expect(results).toMatch(/同じ名前のファイルがあるかを確認しきれませんでした/);
  });

  it('保存先に入れる名前を保存前に決める流れでも、サーバーが名前を無害化した場合は戻り値の name が実際の名前になる', async () => {
    const e = makeEnv();
    const { saved } = await save(e, e.ids.music, [part('a:b.m4a')]);
    expect(saved).toEqual(['a_b.m4a']); // 画面側が決めた名前（a:b.m4a）ではなく、保存された名前
  });
});

// ---------------------------------------------------------------------------------------------
describe('契約書に無いが画面側が気にしていた点（事実の確認）', () => {
  it('uploadChunk に同じ offset を再送しても安全: 受信済みなら Drive に問い合わせて next を返し、データは送り直さない。ファイルは壊れない', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    const data = randomBytes(3 * KB256 + 100, 61);
    const b64 = (a, b) => data.subarray(a, b).toString('base64');
    const total = data.length;
    const { token } = await e.g.call('beginUpload', { folderId: e.ids.music, name: 'dup.m4a', size: total });
    const send = (off) => e.g.call('uploadChunk', token, off, b64(off, Math.min(off + KB256, total)), total);
    expect(await send(0)).toEqual({ success: true, done: false, next: KB256 });
    const puts = () => e.fake.fetchLog.filter((f) => f.kind === 'upload-chunk').length;
    expect(puts()).toBe(1);
    // 0 の再送（応答が失われたと思ったクライアント）: next は進んだまま
    expect(await send(0)).toEqual({ success: true, done: false, next: KB256 });
    expect(puts()).toBe(1);
    expect(await send(KB256)).toEqual({ success: true, done: false, next: 2 * KB256 });
    // 1 つ前の位置の再送もデータは送らない
    expect(await send(KB256)).toEqual({ success: true, done: false, next: 2 * KB256 });
    expect(puts()).toBe(2);
    expect(await send(2 * KB256)).toEqual({ success: true, done: false, next: 3 * KB256 });
    const last = await send(3 * KB256);
    expect(last.done).toBe(true);
    expect(same(e.fake.nodes.get(last.file.id).content, data)).toBe(true);
    // 完了後の最後のチャンクの再送も同じ結果（ファイルは増えない）
    expect(await send(3 * KB256)).toEqual(last);
    expect(e.fake.uploaded()).toHaveLength(1);
  });

  it('beginUpload が再試行されたとき: 最初のセッションは孤児になるが、Drive にファイルは作られない（最後のチャンクが届くまで作られない）', async () => {
    const e = makeEnv();
    const a = await e.g.call('beginUpload', { folderId: e.ids.music, name: 'o.m4a', size: 10 });
    const b = await e.g.call('beginUpload', { folderId: e.ids.music, name: 'o.m4a', size: 10 });
    expect(a.token).not.toBe(b.token);
    expect(e.fake.sessions.size).toBe(2);
    expect(e.fake.uploaded()).toEqual([]);
    expect(e.fake.cacheKeys()).toHaveLength(2); // どちらも 6 時間のキャッシュに残る
    expect(e.fake.cacheTtls.every(([, ttl]) => ttl === 21600)).toBe(true);
  });

  it('resolveLocationInput が音声・動画以外のファイルを返すことはない（PDF・Google ドキュメント・拡張子の無い octet-stream・ショートカットの連鎖は GasError）', async () => {
    const e = makeEnv();
    for (const id of [e.ids.pdf, e.ids.gdoc, e.ids.octetTxt, e.ids.scPdf, e.ids.scShortcut]) {
      const r = await e.g.call('resolveLocationInput', id);
      expect(r.kind, id).toBeUndefined();
      expect(r.error).toBe('フォルダまたは音声・動画ファイルの URL・ID を指定してください。');
    }
    // 返すのは、audio/ video/ の MIME か、既知の拡張子つきの octet-stream
    expect((await e.g.call('resolveLocationInput', e.ids.octet)).item.mimeType).toBe('application/octet-stream');
  });

  it('getFileInfo の size が 0 のファイル: エラー（code なし）。一覧と resolveLocationInput は size: 0 の項目として出す', async () => {
    const e = makeEnv();
    const r = await e.g.call('getFileInfo', e.ids.empty);
    expect(r).toEqual({ error: 'ファイルのサイズを取得できません（空のファイル、または読み込めない形式です）。' });
    expect((await e.g.call('listFolder', 'root')).items.find((i) => i.name === 'empty.mp3')).toMatchObject({ size: 0, canDownload: true });
    expect((await e.g.call('resolveLocationInput', e.ids.empty)).item.size).toBe(0);
    // 画面側のダウンロードにはサーバーのこのメッセージが出る（画面側にも「中身が空」のメッセージがあるが、サーバーが先に断るので到達しない）
    const err = await e.transfer.downloadDriveFile(e.ids.empty).catch((x) => x);
    expect(err.message).toBe(r.error);
    expect(e.g.count('getFileInfo')).toBe(2);
  });

  it('サイズが 500 MB を超えるファイルは、画面側が TOO_LARGE で断る（サーバーの getFileInfo は上限を見ない）', async () => {
    const e = makeEnv();
    const n = e.fake.addFile('huge.wav', 'audio/wav', Buffer.alloc(1), e.fake.rootId, { id: 'FAKEFILE-HUGE-00001' });
    n.content = { length: 501 * 1024 * 1024 }; // 巨大な中身を作らずに size だけ大きくする
    const info = await e.g.call('getFileInfo', n.id);
    expect(info.size).toBe(501 * 1024 * 1024);
    const err = await e.transfer.downloadDriveFile(n.id).catch((x) => x);
    expect(err.code).toBe('TOO_LARGE');
    expect(e.g.count('getFileChunk')).toBe(0);
  });

  it('サーバーの公開関数は、結果に OAuth トークンも Drive のセッション URL も含めない（チャンクの往復を含む一連の操作の全戻り値を検査）', async () => {
    const e = makeEnv({ server: { chunkUnits: 1 } });
    await e.transfer.uploadToDrive(e.ids.music, 'leak.m4a', new Blob([randomBytes(2 * KB256 + 1, 71)]));
    await e.transfer.downloadDriveFile(e.ids.rec);
    await e.g.call('listFolder', 'root');
    const all = e.g.log.map((l) => `${l.args}${l.result}${l.error}`).join('\n');
    expect(all).not.toMatch(/FAKE-OAUTH-TOKEN|Bearer|upload_id|googleapis/);
  });

  it('Code.gs の公開関数は、画面側が呼ぶ名前だけ（src の gasCall / call の呼び出し名がサーバーに存在する）', () => {
    const publicFns = [...SOURCE.matchAll(/^function ([A-Za-z0-9]+)\(/gm)].map((m) => m[1]);
    const called = new Set();
    for (const f of ['App.tsx', 'components/DriveModal.tsx', 'lib/driveTransfer.ts', 'lib/driveStatus.ts']) {
      const text = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
      for (const m of text.matchAll(/(?:gasCall|gas|call)<[^>]*(?:<[^>]*>)?[^>]*>\(\s*'([A-Za-z]+)'/g)) called.add(m[1]);
      for (const m of text.matchAll(/(?:gasCall|gas|call)\(\s*'([A-Za-z]+)'/g)) called.add(m[1]);
    }
    expect([...called].length).toBeGreaterThanOrEqual(8);
    for (const fn of called) expect(publicFns, fn).toContain(fn);
    // 逆: サーバーの Drive 公開関数は、画面側のどこかから呼ばれている
    const serverDrive = publicFns.filter((n) => n !== 'doGet' && !['doGet'].includes(n));
    for (const fn of serverDrive) expect([...called], `${fn} を画面側が呼ばない`).toContain(fn);
  });
});
