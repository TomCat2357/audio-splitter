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
  placeOf,
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
