import { describe, expect, it } from 'vitest';
import {
  PLACES,
  buildCrumbs,
  classifyInput,
  emptyText,
  folderUrl,
  getLastFolder,
  isVirtualId,
  kindOf,
  looksLikeDriveInput,
  placeFor,
  placeOf,
  rowKey,
  setLastFolder,
} from './drivePlaces';

const dummyId = 'dummyFolderId_0123456789abcdef';

const folder = (o: Partial<Parameters<typeof buildCrumbs>[0] & object> = {}) => ({
  id: 'f2',
  name: '会議',
  isRoot: false,
  driveId: null,
  ...o,
});

describe('PLACES', () => {
  it('5 つの場所が決まった順で並ぶ', () => {
    expect(PLACES.map((p) => p.id)).toEqual(['root', 'shared-root', 'shared-with-me', 'starred', 'recent']);
    expect(PLACES.map((p) => p.label)).toEqual(['マイドライブ', '共有ドライブ', '共有アイテム', 'スター付き', '最近使ったもの']);
  });
  it('仮想フォルダの判定', () => {
    expect(isVirtualId('root')).toBe(false);
    expect(isVirtualId(dummyId)).toBe(false);
    for (const id of ['shared-root', 'shared-with-me', 'starred', 'recent']) expect(isVirtualId(id)).toBe(true);
    expect(isVirtualId(null)).toBe(false);
  });
  it('placeOf', () => {
    expect(placeOf(null).id).toBe('root');
    expect(placeOf({ id: 'starred', driveId: null }).id).toBe('starred');
    expect(placeOf({ id: 'x', driveId: 'd1' }).id).toBe('shared-root');
    expect(placeOf({ id: 'x', driveId: null }).id).toBe('root');
  });
});

describe('buildCrumbs', () => {
  it('フォルダが無ければ空', () => {
    expect(buildCrumbs(null, null)).toEqual([]);
  });
  it('仮想フォルダは場所の名前だけ', () => {
    expect(buildCrumbs({ id: 'starred', name: 'x', isRoot: false, driveId: null }, null)).toEqual([
      { id: 'starred', name: 'スター付き', current: true },
    ]);
  });
  it('path があれば上位から並べ、末尾は表示中の名前で current', () => {
    const c = buildCrumbs(folder(), [
      { id: 'root', name: 'My Drive' },
      { id: 'f1', name: '仕事' },
      { id: 'f2', name: '旧名' },
    ]);
    expect(c).toEqual([
      { id: 'root', name: 'マイドライブ', current: false },
      { id: 'f1', name: '仕事', current: false },
      { id: 'f2', name: '会議', current: true },
    ]);
  });
  it('path が取れなかったら、いまのフォルダ名だけ', () => {
    expect(buildCrumbs(folder(), null)).toEqual([{ id: 'f2', name: '会議', current: true }]);
    expect(buildCrumbs(folder(), [])).toEqual([{ id: 'f2', name: '会議', current: true }]);
  });
  it('マイドライブのルートは path が無くても「マイドライブ」', () => {
    expect(buildCrumbs({ id: 'real-root-id', name: 'My Drive', isRoot: true, driveId: null }, null)).toEqual([
      { id: 'root', name: 'マイドライブ', current: true },
    ]);
    expect(buildCrumbs({ id: 'root', name: 'x', isRoot: true, driveId: null }, null)).toEqual([
      { id: 'root', name: 'マイドライブ', current: true },
    ]);
  });
  it('共有ドライブの中は、先頭に「共有ドライブ」を足す', () => {
    const c = buildCrumbs(folder({ driveId: 'd1' }), [
      { id: 'd1', name: '営業部' },
      { id: 'f2', name: '会議' },
    ]);
    expect(c.map((x) => x.name)).toEqual(['共有ドライブ', '営業部', '会議']);
    expect(c[0]).toEqual({ id: 'shared-root', name: '共有ドライブ', current: false });
    expect(c.at(-1)?.current).toBe(true);
  });
  it('current は末尾だけ', () => {
    const c = buildCrumbs(folder(), [
      { id: 'root', name: 'a' },
      { id: 'f2', name: 'b' },
    ]);
    expect(c.filter((x) => x.current)).toHaveLength(1);
  });
});

describe('classifyInput / looksLikeDriveInput', () => {
  it('空や短い単語は検索（none）', () => {
    expect(classifyInput('').kind).toBe('none');
    expect(classifyInput('   ').kind).toBe('none');
    expect(classifyInput('会議').kind).toBe('none');
    expect(classifyInput('meeting 2024').kind).toBe('none');
    expect(looksLikeDriveInput('録音')).toBe(false);
  });
  it('Drive の URL は drive（そのままサーバーで解決）', () => {
    expect(classifyInput(`https://drive.google.com/drive/folders/${dummyId}`)).toEqual({
      kind: 'drive',
      text: `https://drive.google.com/drive/folders/${dummyId}`,
    });
    expect(classifyInput(`https://drive.google.com/file/d/${dummyId}/view?usp=sharing`).kind).toBe('drive');
    expect(classifyInput(`https://docs.google.com/document/d/${dummyId}/edit`).kind).toBe('drive');
    expect(classifyInput(`  "https://drive.google.com/open?id=${dummyId}"  `).kind).toBe('drive');
  });
  it('ID らしい文字列は drive', () => {
    expect(classifyInput(dummyId)).toEqual({ kind: 'drive', text: dummyId });
    expect(looksLikeDriveInput(dummyId)).toBe(true);
  });
  it('場所の URL・名前・root は place', () => {
    expect(classifyInput('https://drive.google.com/drive/my-drive')).toEqual({ kind: 'place', id: 'root' });
    expect(classifyInput('https://drive.google.com/drive/u/1/shared-with-me')).toEqual({ kind: 'place', id: 'shared-with-me' });
    expect(classifyInput('https://drive.google.com/drive/starred?x=1')).toEqual({ kind: 'place', id: 'starred' });
    expect(classifyInput('root')).toEqual({ kind: 'place', id: 'root' });
    expect(classifyInput('共有ドライブ')).toEqual({ kind: 'place', id: 'shared-root' });
  });
  it('ID の境界: 19 文字の共有ドライブ風 ID と通常のファイル ID（33 / 44 文字前後）は ID 扱い', () => {
    const ids = [
      '0AFAKEDRIVEIDDUMMY1', // 19 文字（共有ドライブ風）
      '0AbCdEfGhIjKlMnOpQr9', // 20 文字
      '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', // 33 文字
      '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEf', // 44 文字
    ];
    expect(ids.map((x) => x.length)).toEqual([19, 20, 33, 45]);
    for (const id of ids) {
      expect(classifyInput(id), id).toEqual({ kind: 'drive', text: id });
      expect(looksLikeDriveInput(id)).toBe(true);
    }
  });
  it('ID の境界: 普通の検索語（短い・数字を含まない）は検索扱いのまま', () => {
    for (const w of ['meeting_2024', 'kaigi-rokuon', 'meeting_recording_notes', 'ABCDEFGHIJKLMNOPQRS', '1234567890123456789', 'rec 2024 0101 team a', '会議録音2024']) {
      expect(classifyInput(w).kind, w).toBe('none');
      expect(looksLikeDriveInput(w)).toBe(false);
    }
    expect('ABCDEFGHIJKLMNOPQRS').toHaveLength(19);
    expect('1234567890123456789').toHaveLength(19);
    expect('0AFAKEDRIVEIDDUMM').toHaveLength(17); // 19 文字未満は、数字と英字を含んでいても検索
    expect(classifyInput('0AFAKEDRIVEIDDUMM').kind).toBe('none');
  });
  it('極端に長い入力は無視', () => {
    expect(classifyInput('a'.repeat(3000)).kind).toBe('none');
  });
});

describe('その他', () => {
  it('kindOf', () => {
    expect(kindOf({ type: 'folder', mimeType: 'application/vnd.google-apps.folder' })).toBe('folder');
    expect(kindOf({ type: 'file', mimeType: 'audio/mp4' })).toBe('audio');
    expect(kindOf({ type: 'file', mimeType: 'video/mp4' })).toBe('video');
    expect(kindOf({ type: 'file', mimeType: 'application/octet-stream' })).toBe('file');
  });
  it('kindOf: 汎用の種類（octet-stream・空）は拡張子で判定する（サーバーが一覧に出す条件と同じ）', () => {
    const f = (name: string, mimeType: string) => kindOf({ type: 'file', mimeType, name });
    expect(f('録音.m4a', 'application/octet-stream')).toBe('audio');
    expect(f('REC.M4A', 'application/octet-stream')).toBe('audio');
    expect(f('録音.wma', 'application/octet-stream')).toBe('audio');
    expect(f('録音.aiff', '')).toBe('audio');
    expect(f('clip.mkv', 'application/octet-stream')).toBe('video');
    expect(f('clip.avi', 'binary/octet-stream')).toBe('video');
    expect(f('memo.txt', 'application/octet-stream')).toBe('file');
    expect(f('noext', 'application/octet-stream')).toBe('file');
    expect(f('constructor', 'application/octet-stream')).toBe('file');
    expect(f('x.m4a', 'application/pdf')).toBe('file'); // 具体的な MIME は拡張子より優先
    expect(f('a.ogg', 'application/ogg')).toBe('audio');
    expect(f('x.m4a', 'audio/x-m4a')).toBe('audio');
    expect(kindOf({ type: 'folder', mimeType: 'application/octet-stream', name: 'a.m4a' })).toBe('folder');
  });
  it('rowKey: 同じ ID でも、ショートカットかどうか・名前で別の行になる', () => {
    const file = { id: 'ID1', name: 'rec.m4a' };
    const sc = { id: 'ID1', name: '録音への近道.m4a', shortcut: true as const };
    expect(rowKey(file)).not.toBe(rowKey(sc));
    expect(rowKey(file)).not.toBe(rowKey({ ...file, shortcut: true }));
    expect(rowKey(file)).toBe(rowKey({ ...file }));
  });
  it('placeFor: 場所そのものはその場所、それ以外は入ってきた場所を保つ。なければ placeOf と同じ', () => {
    const inner = { id: 'sharedFolderId01', driveId: null };
    expect(placeFor(inner, 'shared-with-me').key).toBe('shared-with-me');
    expect(placeFor(inner, 'starred').key).toBe('starred');
    expect(placeFor(inner, 'recent').key).toBe('recent');
    expect(placeFor(inner, null).key).toBe('my-drive');
    expect(placeFor({ id: 'x', driveId: 'd1' }, null).key).toBe('shared-drives');
    expect(placeFor({ id: 'x', driveId: 'd1' }, 'shared-with-me').key).toBe('shared-with-me');
    expect(placeFor({ id: 'starred', driveId: null }, 'shared-with-me').key).toBe('starred'); // 場所を直接開いたとき
    expect(placeFor(null, 'recent').key).toBe('recent');
    expect(placeFor(null, null).key).toBe('my-drive');
  });
  it('folderUrl', () => {
    expect(folderUrl('abc')).toBe('https://drive.google.com/drive/folders/abc');
    expect(folderUrl('a/b')).toBe('https://drive.google.com/drive/folders/a%2Fb');
  });
  it('emptyText はモードに合う', () => {
    expect(emptyText({ mode: 'load', searching: false })).toBe('このフォルダに音声ファイルはありません');
    expect(emptyText({ mode: 'save', searching: false })).toContain('フォルダ');
    expect(emptyText({ mode: 'load', searching: true })).toContain('一致');
  });
  it('最後に開いたフォルダは覚えておける（localStorage が無くても動く）', () => {
    setLastFolder('dummy-folder');
    expect(getLastFolder()).toBe('dummy-folder');
  });
});
