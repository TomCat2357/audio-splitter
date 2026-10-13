// gas/Code.gs の Google ドライブ連携を node:vm に読み込み、GAS のサービス（Drive / UrlFetchApp / DriveApp / Session /
// CacheService / ScriptApp / Utilities）をスタブにして確認する。実際の Drive・GAS には一切アクセスしない。
// ID・URL・トークンは見るからにダミーの文字列。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bakeCodeGs } from './bundle-gas.mjs';

const GAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gas');
const SOURCE = fs.readFileSync(path.join(GAS_DIR, 'Code.gs'), 'utf8');

const ROOT = 'FAKEROOTID0123456789';
const FOLDER = 'FAKEFOLDERID0123456789';
const FOLDER2 = 'FAKEFOLDERID9876543210';
const FILE = 'FAKEFILEID0123456789';
const DRIVE_ID = 'FAKESHAREDDRIVE01234';
const SECRET_TOKEN = 'FAKE-OAUTH-TOKEN-SECRET';
const SESSION_URL = 'https://upload.example.test/session/FAKE-SESSION-URL';
const USER = 'user@example.test';
const KB256 = 256 * 1024;

/** JSON を往復して vm の realm の違いを消す。OAuth トークンとセッション URL が戻り値に無いことも毎回確認する。 */
const plain = (x) => {
  const s = JSON.stringify(x === undefined ? null : x);
  expect(s).not.toContain(SECRET_TOKEN);
  expect(s).not.toContain('upload.example.test');
  expect(s).not.toMatch(/Bearer/);
  return JSON.parse(s);
};

function resp(code, { headers = {}, bytes = [], text = '' } = {}) {
  return {
    getResponseCode: () => code,
    getHeaders: () => headers,
    getContent: () => bytes,
    getContentText: () => text,
  };
}

/**
 * env: {
 *   driveEnabled (既定 true), effective / active (メール。null で空), sessionThrows,
 *   files: { get(id, args), list(args), create(res, media, args) }, drives: { list(args) },
 *   fetch(url, opts), driveApp: { getFileById(id) }, touchTrap (true で Drive 等への接触を全部記録して例外)
 * }
 */
function load(env = {}) {
  const calls = { touched: [], fetch: [], filesGet: [], filesList: [], filesCreate: [], drivesList: [], driveApp: [] };
  const store = new Map();
  const trap = (name) => new Proxy({}, { get(_, prop) { calls.touched.push(`${name}.${String(prop)}`); throw new Error(`${name} に触れた`); } });
  const email = (v) => ({ getEmail: () => (v === null ? '' : v) });
  const eff = env.effective === undefined ? USER : env.effective;
  const act = env.active === undefined ? USER : env.active;
  const g = {
    Session: {
      getEffectiveUser: () => { if (env.sessionThrows === 'effective') throw new Error('x'); return email(eff); },
      getActiveUser: () => { if (env.sessionThrows === 'active') throw new Error('x'); return email(act); },
    },
    HtmlService: { XFrameOptionsMode: { DEFAULT: 1 } },
    console: { error() {} },
    Utilities: {
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
      getUuid: () => crypto.randomUUID(),
    },
    CacheService: {
      getUserCache: () => ({
        get: (k) => (store.has(k) ? store.get(k) : null),
        put: (k, v) => { store.set(k, String(v)); },
        remove: (k) => { store.delete(k); },
      }),
    },
    ScriptApp: { getOAuthToken: () => SECRET_TOKEN },
  };
  if (env.touchTrap) {
    g.Drive = trap('Drive');
    g.UrlFetchApp = trap('UrlFetchApp');
    g.DriveApp = trap('DriveApp');
  } else {
    g.Drive = {
      Files: {
        get: (id, args) => { calls.filesGet.push([id, args]); return env.files.get(id, args); },
        list: (args) => { calls.filesList.push(args); return env.files.list(args); },
        create: (res, media, args) => { calls.filesCreate.push([res, media, args]); return env.files.create(res, media, args); },
      },
      Drives: { list: (args) => { calls.drivesList.push(args); return env.drives.list(args); } },
    };
    g.UrlFetchApp = { fetch: (url, opts) => { calls.fetch.push([url, opts]); return env.fetch(url, opts); } };
    g.DriveApp = { getFileById: (id) => { calls.driveApp.push(id); return env.driveApp.getFileById(id); } };
  }
  const ctx = vm.createContext(g);
  vm.runInContext(bakeCodeGs(SOURCE, { driveEnabled: env.driveEnabled !== false }), ctx, { filename: 'Code.gs' });
  const call = (name, ...args) => plain(ctx[name](...args));
  return { ctx, calls, store, call };
}

/** gas/Code.gs の末尾が _ でないトップレベル関数名（= google.script.run から呼べるもの）。 */
const publicFunctions = [...SOURCE.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]);
const DRIVE_PUBLIC = [
  'getDriveStatus', 'listFolder', 'getFolderPath', 'searchDrive', 'resolveLocationInput', 'createFolder',
  'getFileInfo', 'getFileChunk', 'beginUpload', 'uploadChunk', 'abortUpload',
];
/** ガード対象の各関数を、それらしい引数で呼ぶ。 */
const DRIVE_CALLS = {
  getDriveStatus: [],
  listFolder: ['root'],
  getFolderPath: [FOLDER],
  searchDrive: ['abc'],
  resolveLocationInput: [FOLDER],
  createFolder: [FOLDER, 'new'],
  getFileInfo: [FILE],
  getFileChunk: [FILE, 0, 1024],
  beginUpload: [{ folderId: FOLDER, name: 'a.m4a', size: 10 }],
  uploadChunk: ['0123456789abcdef0123', 0, 'AAAA', 10],
  abortUpload: ['0123456789abcdef0123'],
};

// ---------------------------------------------------------------------------------------------
describe('ガード（安全装置 1）', () => {
  it('公開関数の一覧が Code.gs と一致する（新しい公開関数を足したのにガードの一覧・テストに入れ忘れる事故の検出）', () => {
    const pub = publicFunctions.filter((n) => !n.endsWith('_'));
    expect(pub.filter((n) => n !== 'doGet').sort()).toEqual([...DRIVE_PUBLIC].sort());
    expect(Object.keys(DRIVE_CALLS).sort()).toEqual([...DRIVE_PUBLIC].sort());
  });

  it('Drive 関連の各公開関数のソースは、先頭でガードを通している', () => {
    for (const name of DRIVE_PUBLIC.filter((n) => n !== 'getDriveStatus')) {
      const re = new RegExp(`^function ${name}\\([^)]*\\) \\{\\n  var g = driveGuard_\\(\\);\\n  if \\(g\\) return g;\\n`, 'm');
      expect(SOURCE, name).toMatch(re);
    }
  });

  const denied = [
    ['DRIVE_ENABLED_ = false', { driveEnabled: false }],
    ['実効ユーザーとアクセスユーザーが違う', { effective: 'owner@example.test', active: 'visitor@example.test' }],
    ['実効ユーザーが空', { effective: null }],
    ['アクセスユーザーが空', { active: null }],
    ['どちらも空', { effective: null, active: null }],
    ['実効ユーザーの取得が例外', { sessionThrows: 'effective' }],
    ['アクセスユーザーの取得が例外', { sessionThrows: 'active' }],
  ];
  for (const [label, env] of denied) {
    it(`${label}: すべての Drive 公開関数が DRIVE_DISABLED を返し、Drive / UrlFetchApp / DriveApp に触れない`, () => {
      const { call, calls } = load({ ...env, touchTrap: true });
      for (const name of DRIVE_PUBLIC) {
        if (name === 'getDriveStatus') continue;
        const r = call(name, ...DRIVE_CALLS[name]);
        expect(r, name).toEqual({ error: 'この配信設定では Google ドライブ連携は使えません。', code: 'DRIVE_DISABLED' });
      }
      const st = call('getDriveStatus');
      expect(st.enabled).toBe(false);
      expect(typeof st.reason).toBe('string');
      expect(st.reason.length).toBeGreaterThan(0);
      expect(calls.touched).toEqual([]);
    });
  }

  it('Session が使えない環境でも getDriveStatus は例外を投げず無効を返す', () => {
    const ctx = vm.createContext({});
    vm.runInContext(SOURCE, ctx);
    expect(plain(ctx.getDriveStatus()).enabled).toBe(false);
    expect(plain(ctx.listFolder('root')).code).toBe('DRIVE_DISABLED');
  });

  it('実効ユーザーとアクセスユーザーが一致（大文字小文字・前後の空白は無視）し DRIVE_ENABLED_ が true なら通る', () => {
    const { call } = load({ effective: ' User@Example.test ', active: 'user@example.TEST', files: {}, touchTrap: false });
    expect(call('getDriveStatus')).toEqual({ enabled: true });
  });
});

// ---------------------------------------------------------------------------------------------
const folderMeta = (id, extra = {}) => ({ id, name: 'フォルダ' + id.slice(-3), parents: [ROOT], capabilities: { canAddChildren: true }, ...extra });
const file = (id, name, mimeType, extra = {}) => ({ id, name, mimeType, size: '1000', modifiedTime: '2026-01-02T03:04:05.000Z', capabilities: { canDownload: true }, ...extra });

describe('listFolder', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const SHORT = 'application/vnd.google-apps.shortcut';
  const mk = (listImpl, getImpl) => load({
    files: {
      get: getImpl || ((id) => (id === 'root' || id === ROOT ? { id: ROOT, name: 'My Drive', capabilities: { canAddChildren: true } } : folderMeta(id))),
      list: listImpl,
    },
  });

  it('フォルダと音声・動画だけを出す（MIME、octet-stream + 拡張子、ogg。PDF・Google ドキュメント・拡張子違いの octet-stream は出さない）', () => {
    const files = [
      file('AUDIOMP3ID0123456789', 'b.mp3', 'audio/mpeg'),
      file('AUDIOM4AID0123456789', 'a.m4a', 'audio/x-m4a'),
      file('VIDEOMP4ID0123456789', 'v.mp4', 'video/mp4'),
      file('OCTETM4AID0123456789', 'o.M4A', 'application/octet-stream'),
      file('OCTETPDFID0123456789', 'doc.pdf', 'application/octet-stream'),
      file('OCTETNOEXT012345678', 'noext', 'application/octet-stream'),
      file('APPOGGID0123456789', 'x.ogg', 'application/ogg'),
      file('PDFID0123456789ABC', 'x.pdf', 'application/pdf'),
      file('GDOCID0123456789ABC', 'doc', 'application/vnd.google-apps.document'),
      file('GSHEETID0123456789AB', 'sheet', 'application/vnd.google-apps.spreadsheet'),
      file('IMAGEID0123456789ABC', 'p.png', 'image/png'),
      file('SUBFOLDERID0123456789', 'サブ', FOLDER_MIME, { capabilities: { canAddChildren: false } }),
    ];
    const { call, calls } = mk(() => ({ files }));
    const r = call('listFolder', FOLDER);
    expect(r.items.map((i) => i.name)).toEqual(['サブ', 'a.m4a', 'b.mp3', 'o.M4A', 'v.mp4', 'x.ogg']);
    const sub = r.items[0];
    expect(sub).toMatchObject({ type: 'folder', canAddChildren: false, size: null });
    const a = r.items[1];
    expect(a).toMatchObject({ id: 'AUDIOM4AID0123456789', type: 'file', mimeType: 'audio/x-m4a', size: 1000, updated: Date.parse('2026-01-02T03:04:05.000Z'), canDownload: true });
    expect('canAddChildren' in a).toBe(false);
    const q = calls.filesList[0].q;
    expect(q).toContain(`'${FOLDER}' in parents and trashed = false`);
    expect(q).toContain("mimeType contains 'audio/'");
    expect(q).toContain("mimeType contains 'video/'");
    expect(q).toContain("mimeType = 'application/ogg'");
    expect(q).toContain("mimeType = 'application/octet-stream'");
    expect(q).toContain(`mimeType = '${FOLDER_MIME}'`);
    expect(calls.filesList[0]).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true });
    expect(r.truncated).toBeUndefined();
  });

  it('folder の情報: 親・ルート判定・共有ドライブ・保存可否', () => {
    const { call } = mk(() => ({ files: [] }), (id) => {
      if (id === 'root' || id === ROOT) return { id: ROOT, name: 'My Drive', capabilities: { canAddChildren: true } };
      if (id === DRIVE_ID) return { id: DRIVE_ID, name: '共有ドライブ甲', driveId: DRIVE_ID, capabilities: { canAddChildren: false } };
      return folderMeta(id, { driveId: DRIVE_ID });
    });
    expect(call('listFolder', 'root').folder).toEqual({ id: ROOT, name: 'マイドライブ', parentId: null, isRoot: true, driveId: null, canAddChildren: true });
    expect(call('listFolder', '').folder.id).toBe(ROOT);
    expect(call('listFolder', DRIVE_ID).folder).toEqual({ id: DRIVE_ID, name: '共有ドライブ甲', parentId: null, isRoot: true, driveId: DRIVE_ID, canAddChildren: false });
    const f = call('listFolder', FOLDER).folder;
    expect(f).toMatchObject({ id: FOLDER, parentId: ROOT, isRoot: false, driveId: DRIVE_ID, canAddChildren: true });
  });

  it('foldersOnly: フォルダとフォルダを指すショートカットだけ。q に音声の条件を入れない', () => {
    const files = [
      file('SUBFOLDERID0123456789', 'B フォルダ', FOLDER_MIME),
      file('AUDIOMP3ID0123456789', 'a.mp3', 'audio/mpeg'),
      file('SHORTCUTFOLDER012345', 'A 近道', SHORT, { shortcutDetails: { targetId: FOLDER2, targetMimeType: FOLDER_MIME } }),
      file('SHORTCUTAUDIO0123456', '音声の近道', SHORT, { shortcutDetails: { targetId: FILE, targetMimeType: 'audio/mpeg' } }),
    ];
    const { call, calls } = mk(() => ({ files }));
    const r = call('listFolder', FOLDER, { foldersOnly: true });
    expect(r.items.map((i) => i.name)).toEqual(['A 近道', 'B フォルダ']);
    expect(r.items[0]).toMatchObject({ id: FOLDER2, type: 'folder', mimeType: FOLDER_MIME, shortcut: true, canAddChildren: false });
    expect(calls.filesList[0].q).not.toContain('audio/');
    expect(calls.filesList[0].q).not.toContain('octet-stream');
  });

  it('ショートカット: ターゲットの ID・MIME で出し（名前はショートカットのもの）、対象外のターゲットは出さない', () => {
    const files = [
      file('SHORTCUTAUDIO0123456', '近道.mp3', SHORT, { shortcutDetails: { targetId: FILE, targetMimeType: 'audio/mpeg' } }),
      file('SHORTCUTOCTET0123456', '近道.m4a', SHORT, { shortcutDetails: { targetId: 'TARGETOCTET0123456', targetMimeType: 'application/octet-stream' } }),
      file('SHORTCUTOCTETBAD0123', '近道.txt', SHORT, { shortcutDetails: { targetId: 'TARGETOCTET9999999', targetMimeType: 'application/octet-stream' } }),
      file('SHORTCUTPDF01234567', '近道.pdf', SHORT, { shortcutDetails: { targetId: 'TARGETPDF012345678', targetMimeType: 'application/pdf' } }),
      file('SHORTCUTDOC01234567', '近道 doc', SHORT, { shortcutDetails: { targetId: 'TARGETDOC012345678', targetMimeType: 'application/vnd.google-apps.document' } }),
      file('SHORTCUTNODETAILS0123', '詳細なし', SHORT),
      file('SHORTCUTBADID012345', '不正な ID', SHORT, { shortcutDetails: { targetId: "x' or '1'='1", targetMimeType: 'audio/mpeg' } }),
    ];
    const { call } = mk(() => ({ files }));
    const r = call('listFolder', FOLDER);
    expect(r.items.map((i) => i.name)).toEqual(['近道.m4a', '近道.mp3']);
    expect(r.items.find((i) => i.name === '近道.mp3')).toMatchObject({ id: FILE, mimeType: 'audio/mpeg', shortcut: true, size: null, type: 'file' });
  });

  it('ページングを最後まで辿り、上限を超えたら truncated: true', () => {
    const page = (n, start) => Array.from({ length: n }, (_, i) => file(`AUDIOID${String(start + i).padStart(13, '0')}`, `f${String(start + i).padStart(3, '0')}.mp3`, 'audio/mpeg'));
    const { call, calls, ctx } = mk((args) => (args.pageToken ? { files: page(2, 3) } : { files: page(3, 0), nextPageToken: 'TOKEN2' }));
    expect(call('listFolder', FOLDER).items).toHaveLength(5);
    expect(calls.filesList[1].pageToken).toBe('TOKEN2');
    expect(calls.filesList[0].pageToken).toBeUndefined();
    vm.runInContext('DRIVE_FOLDER_MAX_ITEMS_ = 4', ctx);
    const r = call('listFolder', FOLDER);
    expect(r.items).toHaveLength(4);
    expect(r.truncated).toBe(true);
  });

  it('不正な ID は q に連結せず、Drive を呼ばずにエラー', () => {
    const { call, calls } = mk(() => ({ files: [] }));
    for (const bad of ["x' or '1'='1", 'short', `${FOLDER}' in parents or '1`, 'a b c d e f g h i j', '../etc/passwd01']) {
      const r = call('listFolder', bad);
      expect(r.error, bad).toBeTruthy();
    }
    expect(calls.filesList).toEqual([]);
    expect(calls.filesGet).toEqual([]);
  });

  it('仮想フォルダ: 共有ドライブの一覧 / 共有アイテム / スター付き / 最近使ったもの', () => {
    const { call, calls } = load({
      files: { get: () => { throw new Error('実フォルダは引かない'); }, list: (args) => ({ files: [file('AUDIOMP3ID0123456789', 'x.mp3', 'audio/mpeg'), file('PDFID0123456789ABC', 'x.pdf', 'application/pdf')] }) },
      drives: { list: () => ({ drives: [{ id: DRIVE_ID, name: '乙ドライブ', capabilities: { canAddChildren: true } }, { id: 'FAKESHAREDDRIVE99999', name: '甲ドライブ', capabilities: { canAddChildren: false } }] }) },
    });
    const sr = call('listFolder', 'shared-root');
    expect(sr.folder).toEqual({ id: 'shared-root', name: '共有ドライブ', parentId: null, isRoot: true, driveId: null, canAddChildren: false });
    expect(sr.items.map((i) => i.name)).toEqual(['乙ドライブ', '甲ドライブ'].sort((a, b) => a.localeCompare(b)));
    expect(sr.items.find((i) => i.id === DRIVE_ID)).toMatchObject({ type: 'folder', driveId: DRIVE_ID, canAddChildren: true, size: null, updated: null });
    for (const [id, name, frag] of [['shared-with-me', '共有アイテム', 'sharedWithMe = true'], ['starred', 'スター付き', 'starred = true'], ['recent', '最近使ったもの', 'viewedByMeTime']]) {
      const r = call('listFolder', id);
      expect(r.folder).toEqual({ id, name, parentId: null, isRoot: true, driveId: null, canAddChildren: false });
      expect(r.items.map((i) => i.name)).toEqual(['x.mp3']);
      expect(calls.filesList.at(-1).q).toContain(frag);
      expect(calls.filesList.at(-1).q).toContain('trashed = false');
    }
    expect(calls.filesGet).toEqual([]);
    expect(call('listFolder', 'recent', { foldersOnly: true }).items).toEqual([]);
  });

  it('仮想フォルダの上限（truncated）', () => {
    const many = Array.from({ length: 5 }, (_, i) => file(`AUDIOID${String(i).padStart(13, '0')}`, `f${i}.mp3`, 'audio/mpeg'));
    const { call, ctx } = load({ files: { list: () => ({ files: many }) }, drives: { list: () => ({ drives: [] }) } });
    vm.runInContext('DRIVE_VIRTUAL_MAX_ITEMS_ = 3', ctx);
    const r = call('listFolder', 'starred');
    expect(r.items).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it('Drive の例外は { error } にして返す（例外を投げない）', () => {
    const { call } = mk(() => { throw new Error('API call to drive.files.list failed with error: Internal'); });
    const r = call('listFolder', FOLDER);
    expect(r.error).toMatch(/Google ドライブの処理に失敗しました/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('getFolderPath', () => {
  const tree = {
    [ROOT]: { id: ROOT, name: 'My Drive', parents: undefined },
    [FOLDER]: { id: FOLDER, name: '案件', parents: [ROOT] },
    [FOLDER2]: { id: FOLDER2, name: '2026', parents: [FOLDER] },
    [DRIVE_ID]: { id: DRIVE_ID, name: '共有ドライブ甲', driveId: DRIVE_ID },
    FAKESHAREDCHILD01234: { id: 'FAKESHAREDCHILD01234', name: '子', parents: [DRIVE_ID], driveId: DRIVE_ID },
  };
  const get = (id) => {
    if (id === 'root') return { id: ROOT };
    if (!tree[id]) throw new Error('File not found: ' + id);
    return tree[id];
  };

  it('マイドライブ: root から自分まで', () => {
    const { call } = load({ files: { get } });
    expect(call('getFolderPath', FOLDER2)).toEqual({ path: [{ id: 'root', name: 'マイドライブ' }, { id: FOLDER, name: '案件' }, { id: FOLDER2, name: '2026' }] });
    expect(call('getFolderPath', 'root')).toEqual({ path: [{ id: 'root', name: 'マイドライブ' }] });
    expect(call('getFolderPath', undefined)).toEqual({ path: [{ id: 'root', name: 'マイドライブ' }] });
  });

  it('共有ドライブのルートで止める', () => {
    const { call } = load({ files: { get } });
    expect(call('getFolderPath', 'FAKESHAREDCHILD01234').path).toEqual([{ id: DRIVE_ID, name: '共有ドライブ甲' }, { id: 'FAKESHAREDCHILD01234', name: '子' }]);
  });

  it('親にアクセスできなければそこで打ち切る。自分自身が取れないのはエラー', () => {
    const { call } = load({ files: { get: (id) => (id === FOLDER ? (() => { throw new Error('File not found'); })() : get(id)) } });
    expect(call('getFolderPath', FOLDER2).path).toEqual([{ id: FOLDER2, name: '2026' }]);
    expect(call('getFolderPath', 'NOSUCHFOLDER0123456').error).toBeTruthy();
  });

  it('最大 20 階層（循環していても止まる）', () => {
    const A = 'FAKECYCLEIDAAAAAAAA';
    const B = 'FAKECYCLEIDBBBBBBBB';
    const { call } = load({ files: { get: (id) => (id === 'root' ? { id: ROOT } : { id, name: id.slice(-3), parents: [id === A ? B : A] }) } });
    expect(call('getFolderPath', A).path).toHaveLength(20);
  });

  it('仮想フォルダ ID はその 1 要素だけ返し、Drive に触れない。不正な ID はエラー', () => {
    const { call, calls } = load({ files: { get } });
    expect(call('getFolderPath', 'shared-root')).toEqual({ path: [{ id: 'shared-root', name: '共有ドライブ' }] });
    expect(call('getFolderPath', 'recent')).toEqual({ path: [{ id: 'recent', name: '最近使ったもの' }] });
    expect(calls.filesGet).toEqual([]);
    expect(call('getFolderPath', "x' or '1'='1").error).toBeTruthy();
    expect(calls.filesGet).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('searchDrive', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const mk = (list) => load({ files: { list } });

  it('引用符とバックスラッシュを含む検索語をエスケープして q に入れる', () => {
    const { call, calls } = mk(() => ({ files: [] }));
    call('searchDrive', "O'Brien \\ x' or name contains '");
    const q = calls.filesList[0].q;
    expect(q.startsWith("name contains 'O\\'Brien \\\\ x\\' or name contains \\'' and trashed = false and (")).toBe(true);
    expect(calls.filesList[0]).toMatchObject({ corpora: 'allDrives', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 100 });
  });

  it('結果はフォルダ → 名前順。対象外の種類は除く。truncated は nextPageToken / incompleteSearch から', () => {
    const files = [file('AUDIOMP3ID0123456789', 'b.mp3', 'audio/mpeg'), file('SUBFOLDERID0123456789', 'z', FOLDER_MIME), file('PDFID0123456789ABC', 'a.pdf', 'application/pdf')];
    const { call } = mk(() => ({ files, nextPageToken: 'T' }));
    const r = call('searchDrive', '  録音  ');
    expect(r.query).toBe('録音');
    expect(r.items.map((i) => i.name)).toEqual(['z', 'b.mp3']);
    expect(r.truncated).toBe(true);
    expect(load({ files: { list: () => ({ files: [], incompleteSearch: true }) } }).call('searchDrive', 'a').truncated).toBe(true);
    expect(load({ files: { list: () => ({ files: [] }) } }).call('searchDrive', 'a').truncated).toBe(false);
  });

  it('foldersOnly / 空の検索語 / 長すぎる検索語', () => {
    const { call, calls } = mk(() => ({ files: [] }));
    call('searchDrive', 'a', { foldersOnly: true });
    expect(calls.filesList[0].q).not.toContain('audio/');
    expect(call('searchDrive', '   ').error).toBeTruthy();
    expect(call('searchDrive', 'x'.repeat(257)).error).toBeTruthy();
    expect(calls.filesList).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('resolveLocationInput', () => {
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const SHORT = 'application/vnd.google-apps.shortcut';
  const metas = {
    [FOLDER]: { id: FOLDER, name: '案件', mimeType: FOLDER_MIME, parents: [ROOT] },
    [FILE]: { id: FILE, name: '録音.m4a', mimeType: 'audio/x-m4a', size: '2048', parents: [FOLDER], modifiedTime: '2026-01-02T03:04:05.000Z', capabilities: { canDownload: true } },
    PDFFILEID0123456789: { id: 'PDFFILEID0123456789', name: 'a.pdf', mimeType: 'application/pdf', parents: [FOLDER] },
    SHORTCUTID0123456789: { id: 'SHORTCUTID0123456789', name: '近道', mimeType: SHORT, shortcutDetails: { targetId: FILE, targetMimeType: 'audio/x-m4a' } },
    SHORTFOLDERID012345: { id: 'SHORTFOLDERID012345', name: '近道フォルダ', mimeType: SHORT, shortcutDetails: { targetId: FOLDER, targetMimeType: FOLDER_MIME } },
  };
  const mk = () => load({ files: { get: (id) => { if (id === 'root') return { id: ROOT, name: 'My Drive', mimeType: FOLDER_MIME }; if (!metas[id]) throw new Error('File not found'); return metas[id]; } } });

  it('フォルダの URL / ID', () => {
    const { call } = mk();
    expect(call('resolveLocationInput', `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`)).toEqual({ kind: 'folder', id: FOLDER, name: '案件' });
    expect(call('resolveLocationInput', FOLDER)).toEqual({ kind: 'folder', id: FOLDER, name: '案件' });
    expect(call('resolveLocationInput', `https://drive.google.com/drive/u/0/folders/${FOLDER}`).id).toBe(FOLDER);
    expect(call('resolveLocationInput', 'root')).toEqual({ kind: 'folder', id: ROOT, name: 'マイドライブ' });
  });

  it('音声ファイルの URL / ID は項目と親を返す。ショートカットはターゲットへ', () => {
    const { call } = mk();
    const r = call('resolveLocationInput', `https://drive.google.com/file/d/${FILE}/view?usp=sharing`);
    expect(r).toEqual({
      kind: 'file',
      item: { id: FILE, name: '録音.m4a', type: 'file', mimeType: 'audio/x-m4a', size: 2048, updated: Date.parse('2026-01-02T03:04:05.000Z'), canDownload: true },
      parentId: FOLDER,
    });
    expect(call('resolveLocationInput', `https://drive.google.com/open?id=${FILE}`).item.id).toBe(FILE);
    expect(call('resolveLocationInput', 'SHORTCUTID0123456789')).toMatchObject({ kind: 'file', item: { id: FILE, name: '録音.m4a' }, parentId: FOLDER });
    expect(call('resolveLocationInput', 'SHORTFOLDERID012345')).toEqual({ kind: 'folder', id: FOLDER, name: '案件' });
  });

  it('対象外の種類・読めない入力・見つからない ID はエラー', () => {
    const { call, calls } = mk();
    expect(call('resolveLocationInput', 'PDFFILEID0123456789').error).toMatch(/音声/);
    expect(call('resolveLocationInput', 'NOSUCHFILEID0123456').error).toBeTruthy();
    const before = calls.filesGet.length;
    for (const bad of ['', '   ', 'hello', "x' or '1'='1", 'https://example.test/', 'a'.repeat(3000)]) expect(call('resolveLocationInput', bad).error, bad).toBeTruthy();
    expect(calls.filesGet.length).toBe(before + 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('createFolder', () => {
  const mk = () => load({ files: { create: (res) => ({ id: 'NEWFOLDERID0123456789', name: res.name }) } });

  it('名前を無害化して親の下に新規作成する（supportsAllDrives）', () => {
    const { call, calls } = mk();
    const r = call('createFolder', FOLDER, '  a/b\\c:d*e?f"g<h>i|j\u0001 ');
    expect(r).toEqual({ success: true, id: 'NEWFOLDERID0123456789', name: 'a_b_c_d_e_f_g_h_i_j' });
    const [res, media, args] = calls.filesCreate[0];
    expect(res).toEqual({ name: 'a_b_c_d_e_f_g_h_i_j', mimeType: 'application/vnd.google-apps.folder', parents: [FOLDER] });
    expect(media).toBeNull();
    expect(args).toMatchObject({ supportsAllDrives: true });
    expect(call('createFolder', 'root', 'x').success).toBe(true);
    expect(calls.filesCreate[1][0].name).toBe('x');
    expect(calls.filesCreate[1][0].parents).toEqual(['root']);
  });

  it('150 文字に切り詰める。空の名前・仮想フォルダ・不正な親は作らない', () => {
    const { call, calls } = mk();
    expect(call('createFolder', FOLDER, 'あ'.repeat(200)).name).toHaveLength(150);
    const before = calls.filesCreate.length;
    expect(call('createFolder', FOLDER, '  ').error).toBeTruthy();
    expect(call('createFolder', FOLDER, '\u0001\u0002').error).toBeTruthy();
    for (const bad of ['starred', 'recent', 'shared-root', 'shared-with-me', '', "x' or '1'='1"]) expect(call('createFolder', bad, 'a').error, bad).toBeTruthy();
    expect(calls.filesCreate.length).toBe(before);
  });

  it('作成の失敗は { error } で返す', () => {
    const { call } = load({ files: { create: () => { throw new Error('Insufficient permissions'); } } });
    expect(call('createFolder', FOLDER, 'a').error).toBe('この操作を行う権限がありません。');
  });
});

// ---------------------------------------------------------------------------------------------
describe('getFileInfo', () => {
  const SHORT = 'application/vnd.google-apps.shortcut';
  const metas = {
    [FILE]: { id: FILE, name: '録音.m4a', mimeType: 'audio/mp4', size: '5000', parents: [FOLDER], modifiedTime: '2026-01-02T03:04:05.000Z', capabilities: { canDownload: true } },
    SHORTCUTID0123456789: { id: 'SHORTCUTID0123456789', name: '近道', mimeType: SHORT, shortcutDetails: { targetId: FILE, targetMimeType: 'audio/mp4' } },
    RESTRICTED012345678: { id: 'RESTRICTED012345678', name: 'r.mp3', mimeType: 'audio/mpeg', size: '5000', capabilities: { canDownload: false } },
    NOSIZEFILE01234567: { id: 'NOSIZEFILE01234567', name: 'n.mp3', mimeType: 'audio/mpeg', capabilities: { canDownload: true } },
    ZEROSIZEFILE0123456: { id: 'ZEROSIZEFILE0123456', name: 'z.mp3', mimeType: 'audio/mpeg', size: '0' },
    PDFFILEID0123456789: { id: 'PDFFILEID0123456789', name: 'a.pdf', mimeType: 'application/pdf', size: '10' },
    FOLDERID0123456789: { id: 'FOLDERID0123456789', name: 'f', mimeType: 'application/vnd.google-apps.folder' },
  };
  const mk = () => load({ files: { get: (id) => { if (!metas[id]) throw new Error('File not found'); return metas[id]; } } });

  it('契約どおりの形。chunkSize は 8 MiB（256 KiB の倍数）', () => {
    const { call } = mk();
    const r = call('getFileInfo', FILE);
    expect(r).toEqual({ success: true, id: FILE, name: '録音.m4a', size: 5000, mimeType: 'audio/mp4', updated: Date.parse('2026-01-02T03:04:05.000Z'), parentId: FOLDER, chunkSize: 8 * 1024 * 1024 });
    expect(r.chunkSize % KB256).toBe(0);
  });

  it('ショートカットの ID はターゲットへ解決する', () => {
    const { call } = mk();
    expect(call('getFileInfo', 'SHORTCUTID0123456789')).toMatchObject({ success: true, id: FILE, name: '録音.m4a' });
  });

  it('ダウンロード禁止は DOWNLOAD_RESTRICTED。サイズ不明・0・音声動画でない・フォルダ・不正な ID・見つからないはエラー', () => {
    const { call } = mk();
    expect(call('getFileInfo', 'RESTRICTED012345678')).toMatchObject({ code: 'DOWNLOAD_RESTRICTED' });
    for (const id of ['NOSIZEFILE01234567', 'ZEROSIZEFILE0123456', 'PDFFILEID0123456789', 'FOLDERID0123456789', 'bad', 'NOSUCHFILEID0123456', 'root']) {
      const r = call('getFileInfo', id);
      expect(r.error, id).toBeTruthy();
      expect(r.code, id).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('getFileChunk', () => {
  const bytes = (n, start = 0) => Array.from({ length: n }, (_, i) => (start + i) % 256);
  const b64 = (arr) => Buffer.from(arr).toString('base64');
  const noDriveApp = { getFileById: () => { throw new Error('DriveApp は使わない'); } };

  it('206: Range ヘッダを付けて読み、base64 と etag、partial: true を返す。トークンは返さない', () => {
    const { call, calls } = load({ files: { get: () => { throw new Error('呼ばない'); } }, driveApp: noDriveApp, fetch: () => resp(206, { bytes: bytes(10, 5), headers: { ETag: '"v1"' } }) });
    const r = call('getFileChunk', FILE, 5, 10);
    expect(r).toEqual({ success: true, offset: 5, length: 10, data: b64(bytes(10, 5)), etag: '"v1"', partial: true });
    const [url, opts] = calls.fetch[0];
    expect(url).toBe(`https://www.googleapis.com/drive/v3/files/${FILE}?alt=media&supportsAllDrives=true`);
    expect(opts.headers.Range).toBe('bytes=5-14');
    expect(opts.headers.Authorization).toBe('Bearer ' + SECRET_TOKEN);
    expect(opts.muteHttpExceptions).toBe(true);
    expect(calls.filesGet).toEqual([]);
  });

  it('200（Range が無視された）: 自前で slice し partial: false', () => {
    const { call } = load({ files: {}, driveApp: noDriveApp, fetch: () => resp(200, { bytes: bytes(100), headers: { etag: 'W/"x"' } }) });
    const r = call('getFileChunk', FILE, 20, 30);
    expect(r).toEqual({ success: true, offset: 20, length: 30, data: b64(bytes(30, 20)), etag: 'W/"x"', partial: false });
    expect(call('getFileChunk', FILE, 90, 30).length).toBe(10);
  });

  it('416（offset が EOF 以降）: 空データ、partial: true', () => {
    const { call } = load({ files: {}, driveApp: noDriveApp, fetch: () => resp(416, { headers: { ETag: '"v1"' } }) });
    expect(call('getFileChunk', FILE, 99999, 10)).toEqual({ success: true, offset: 99999, length: 0, data: '', etag: '"v1"', partial: true });
  });

  it('引数の範囲検査（offset は 0 以上の整数、length は 1〜16 MiB の整数、ID の形）。通信しない・retryable を付けない', () => {
    const { call, calls } = load({ files: {}, driveApp: noDriveApp, fetch: () => resp(206, { bytes: [1] }) });
    const bad = [[FILE, -1, 10], [FILE, 1.5, 10], [FILE, 'a', 10], [FILE, 0, 0], [FILE, 0, 16 * 1024 * 1024 + 1], [FILE, 0, 'x'], [FILE, 0, ''], [FILE, null, 1], ['short', 0, 10], ["x' or 1=1 --abcdefg", 0, 10], ['root', 0, 10]];
    for (const a of bad) {
      const r = call('getFileChunk', ...a);
      expect(r.error, JSON.stringify(a)).toBeTruthy();
      expect(r.retryable).toBeUndefined();
    }
    expect(calls.fetch).toEqual([]);
    expect(call('getFileChunk', FILE, 0, 16 * 1024 * 1024).success).toBe(true);
  });

  it('ダウンロード禁止（403 で、メタデータが canDownload:false）は DOWNLOAD_RESTRICTED（retryable なし）', () => {
    const { call } = load({
      files: { get: () => ({ capabilities: { canDownload: false } }) },
      fetch: () => resp(403),
      driveApp: { getFileById: () => { throw new Error('Forbidden'); } },
    });
    const r = call('getFileChunk', FILE, 0, 10);
    expect(r).toEqual({ error: '所有者によりダウンロードが制限されているため、ファイルを取得できません。', code: 'DOWNLOAD_RESTRICTED' });
  });

  it('一時的な失敗（429 / 500 / 502 / 503 / 504、fetch の例外）は、DriveApp にも Drive API にも行かず retryable: true で返す', () => {
    const blobOk = { getFileById: () => ({ getBlob: () => ({ getBytes: () => bytes(50) }), getSize: () => 50 }) }; // 使えてしまう DriveApp でも、呼ばれないこと
    const cases = [
      ...[429, 500, 502, 503, 504].map((s) => ({ label: String(s), fetch: () => resp(s) })),
      { label: 'fetch の例外', fetch: () => { throw new Error('Exception: Timeout'); } },
      { label: '403 rateLimitExceeded', fetch: () => resp(403, { text: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' }) },
    ];
    for (const c of cases) {
      const t = load({ files: { get: () => ({ mimeType: 'audio/mp4' }) }, fetch: c.fetch, driveApp: blobOk });
      const r = t.call('getFileChunk', FILE, 10, 5);
      expect(r.retryable, c.label).toBe(true);
      expect(r.success, c.label).toBeUndefined();
      expect(r.error, c.label).toBeTruthy();
      expect(t.calls.driveApp, c.label).toEqual([]);
      expect(t.calls.fetch, c.label).toHaveLength(1); // 再試行は画面側がする
      expect(JSON.stringify(r), c.label).not.toContain(SECRET_TOKEN);
    }
  });

  it('ショートカットの ID で一時的な失敗が続く場合も retryable（ターゲットでの読み直しの応答が 5xx のとき）', () => {
    const TARGET = 'TARGETFILEID0123456';
    const t = load({
      files: { get: () => ({ mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: TARGET } }) },
      driveApp: noDriveApp,
      fetch: (url) => (url.includes(TARGET) ? resp(503) : resp(404)),
    });
    expect(t.call('getFileChunk', 'SHORTCUTID0123456789', 0, 3).retryable).toBe(true);
    expect(t.calls.driveApp).toEqual([]);
  });

  it('404 は DriveApp に行かず、retryable なしのエラー', () => {
    const t = load({ files: { get: () => ({ mimeType: 'audio/mp4' }) }, fetch: () => resp(404), driveApp: noDriveApp });
    const r = t.call('getFileChunk', FILE, 0, 10);
    expect(r.error).toMatch(/見つかりません/);
    expect(r.retryable).toBeUndefined();
    expect(t.calls.driveApp).toEqual([]);
  });

  it('Range 取得そのものが通らないとき（400 / 401 / 403・上限以外）は DriveApp にフォールバック（etag なし・partial: false）。大きすぎるファイルは諦める', () => {
    const blob = (arr) => ({ getBlob: () => ({ getBytes: () => arr }), getSize: () => arr.length });
    for (const s of [400, 401, 403]) {
      const ok = load({ files: { get: () => ({}) }, fetch: () => resp(s), driveApp: { getFileById: () => blob(bytes(50)) } });
      expect(ok.call('getFileChunk', FILE, 10, 5), String(s)).toEqual({ success: true, offset: 10, length: 5, data: b64(bytes(5, 10)), etag: null, partial: false });
      expect(ok.calls.driveApp).toHaveLength(1);
    }
    const big = load({ files: { get: () => ({}) }, fetch: () => resp(400), driveApp: { getFileById: () => ({ getSize: () => 51 * 1024 * 1024, getBlob: () => { throw new Error('読まない'); } }) } });
    const r = big.call('getFileChunk', FILE, 0, 10);
    expect(r.retryable).toBe(true);
    expect(r.error).toBeTruthy();
  });

  it('フォールバックの DriveApp も失敗したら、通信系として retryable: true（400 のあと DriveApp が例外）', () => {
    const fail = { getFileById: () => { throw new Error('Service unavailable') } };
    const t = load({ files: { get: () => ({}) }, fetch: () => resp(400), driveApp: fail });
    expect(t.call('getFileChunk', FILE, 0, 10)).toMatchObject({ retryable: true });
  });

  it('ショートカットの ID を渡されたら、ターゲットで読み直す', () => {
    const TARGET = 'TARGETFILEID0123456';
    const { call, calls } = load({
      files: { get: (id) => ({ mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: TARGET } }) },
      driveApp: noDriveApp,
      fetch: (url) => (url.includes(TARGET) ? resp(206, { bytes: [1, 2, 3] }) : resp(404)),
    });
    const r = call('getFileChunk', 'SHORTCUTID0123456789', 0, 3);
    expect(r).toMatchObject({ success: true, length: 3, partial: true });
    expect(calls.fetch).toHaveLength(2);
    expect(calls.fetch[1][0]).toContain(TARGET);
  });
});

// ---------------------------------------------------------------------------------------------
describe('beginUpload / uploadChunk / abortUpload', () => {
  const TOTAL = 3 * KB256 - 100;
  const chunkB64 = (n, fill = 7) => Buffer.alloc(n, fill).toString('base64');
  /** セッション作成だけ成功する fetch。以降の応答は次の配列から順に返す。 */
  const mk = (responses = []) => {
    const queue = [...responses];
    const env = {
      files: {}, driveApp: {},
      fetch: (url, opts) => {
        if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) return resp(200, { headers: { Location: SESSION_URL } });
        if (!queue.length) throw new Error('想定外の fetch: ' + url);
        const next = queue.shift();
        return typeof next === 'function' ? next(url, opts) : next;
      },
    };
    return { ...load(env), queue };
  };
  const begin = (t, meta = { folderId: FOLDER, name: '録音_1.m4a', size: TOTAL }) => t.call('beginUpload', meta);

  it('拡張子から MIME を決め（クライアントの申告は無視）、レジューム可能アップロードを開始する。戻り値はトークンと chunkSize だけ', () => {
    const t = mk();
    const r = begin(t, { folderId: FOLDER, name: '録音.M4A', size: 1000, mimeType: 'application/x-evil', parents: ['EVIL'] });
    expect(Object.keys(r).sort()).toEqual(['chunkSize', 'success', 'token']);
    expect(r.success).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.chunkSize).toBe(8 * 1024 * 1024);
    const [url, opts] = t.calls.fetch[0];
    expect(url).toContain('uploadType=resumable');
    expect(url).toContain('supportsAllDrives=true');
    expect(opts.method).toBe('post');
    expect(JSON.parse(opts.payload)).toEqual({ name: '録音.M4A', mimeType: 'audio/mp4', parents: [FOLDER] });
    expect(opts.headers['X-Upload-Content-Type']).toBe('audio/mp4');
    expect(opts.headers['X-Upload-Content-Length']).toBe('1000');
    expect(opts.headers.Authorization).toBe('Bearer ' + SECRET_TOKEN);
    // セッション URL はサーバーのキャッシュにだけある
    expect([...t.store.values()].join()).toContain(SESSION_URL);
  });

  it('拡張子ごとの MIME（音声・動画の許可リスト）と、対象外の拡張子の拒否', () => {
    const cases = { 'a.mp3': 'audio/mpeg', 'a.wav': 'audio/wav', 'a.flac': 'audio/flac', 'a.ogg': 'audio/ogg', 'a.mp4': 'video/mp4', 'a.mov': 'video/quicktime', 'a.webm': 'video/webm', 'a.mkv': 'video/x-matroska', 'a.3gp': 'video/3gpp' };
    for (const [name, mime] of Object.entries(cases)) {
      const t = mk();
      expect(begin(t, { folderId: FOLDER, name, size: 10 }).success, name).toBe(true);
      expect(JSON.parse(t.calls.fetch[0][1].payload).mimeType, name).toBe(mime);
    }
    for (const name of ['a.exe', 'a.pdf', 'a.html', 'a.js', 'a.zip', 'a.txt', 'noext', 'a.mp3.exe', 'a.', '.m4a.png']) {
      const t = mk();
      const r = begin(t, { folderId: FOLDER, name, size: 10 });
      expect(r.error, name).toBeTruthy();
      expect(t.calls.fetch, name).toEqual([]);
    }
  });

  it('ファイル名の無害化と既定名', () => {
    const t = mk();
    begin(t, { folderId: FOLDER, name: 'a/b\\c:d.mp3', size: 10 });
    expect(JSON.parse(t.calls.fetch[0][1].payload).name).toBe('a_b_c_d.mp3');
    const t2 = mk();
    begin(t2, { folderId: FOLDER, name: '   ', size: 10 });
    expect(JSON.parse(t2.calls.fetch[0][1].payload).name).toBe('audio.m4a');
  });

  it('size の範囲（1 以上 500 MB まで・整数）と、保存先の検査。不正なら Drive へ通信しない', () => {
    const MAX = 500 * 1024 * 1024;
    expect(begin(mk(), { folderId: FOLDER, name: 'a.mp3', size: MAX }).success).toBe(true);
    for (const size of [0, -1, MAX + 1, 1.5, 'abc', null, undefined, NaN]) {
      const t = mk();
      expect(begin(t, { folderId: FOLDER, name: 'a.mp3', size }).error, String(size)).toBeTruthy();
      expect(t.calls.fetch).toEqual([]);
    }
    for (const folderId of ['starred', 'recent', 'shared-root', 'shared-with-me', '', undefined, "x' or '1'='1", 'short']) {
      const t = mk();
      expect(begin(t, { folderId, name: 'a.mp3', size: 10 }).error, String(folderId)).toBeTruthy();
      expect(t.calls.fetch).toEqual([]);
    }
    const t = mk();
    expect(t.call('beginUpload', null).error).toBeTruthy();
    expect(t.call('beginUpload', { folderId: 'root', name: 'a.mp3', size: 10 }).success).toBe(true);
    expect(JSON.parse(t.calls.fetch[0][1].payload).parents).toEqual(['root']);
  });

  it('開始の失敗: 403 / 404 は日本語の案内、5xx は retryable', () => {
    const mkFail = (code) => load({ files: {}, driveApp: {}, fetch: () => resp(code, { text: 'detail' }) });
    expect(begin(mkFail(403)).error).toMatch(/権限/);
    expect(begin(mkFail(404)).error).toMatch(/見つかりません/);
    expect(begin(mkFail(403)).retryable).toBeUndefined();
    expect(begin(mkFail(503)).retryable).toBe(true);
    expect(begin(mkFail(503)).error).toContain('503');
    // Location ヘッダが無い
    const noLoc = load({ files: {}, driveApp: {}, fetch: () => resp(200, { headers: {} }) });
    expect(begin(noLoc).error).toBeTruthy();
  });

  it('308 → 続行 → 完了。Content-Range・followRedirects:false・完了時にセッションを削除。戻り値は { id, name } だけ', () => {
    const t = mk([
      resp(308, { headers: { Range: `bytes=0-${KB256 - 1}` } }),
      resp(308, { headers: { Range: `bytes=0-${2 * KB256 - 1}` } }),
      resp(200, { text: JSON.stringify({ id: 'NEWFILEID0123456789', name: '録音_1.m4a', modifiedTime: 'x', md5Checksum: 'y' }) }),
    ]);
    const { token } = begin(t);
    const r1 = t.call('uploadChunk', token, 0, chunkB64(KB256), TOTAL);
    expect(r1).toEqual({ success: true, done: false, next: KB256 });
    const [url, opts] = t.calls.fetch[1];
    expect(url).toBe(SESSION_URL);
    expect(opts.method).toBe('put');
    expect(opts.followRedirects).toBe(false);
    expect(opts.headers['Content-Range']).toBe(`bytes 0-${KB256 - 1}/${TOTAL}`);
    expect(opts.headers.Authorization).toBeUndefined();
    expect(opts.payload).toHaveLength(KB256);
    expect(t.call('uploadChunk', token, KB256, chunkB64(KB256), TOTAL)).toEqual({ success: true, done: false, next: 2 * KB256 });
    const last = TOTAL - 2 * KB256;
    expect(t.call('uploadChunk', token, 2 * KB256, chunkB64(last), TOTAL)).toEqual({ success: true, done: true, next: TOTAL, file: { id: 'NEWFILEID0123456789', name: '録音_1.m4a' } });
    expect(t.calls.fetch[3][1].headers['Content-Range']).toBe(`bytes ${2 * KB256}-${TOTAL - 1}/${TOTAL}`);
    // 完了後は、Drive のセッション URL を含まない「完了済み」の印だけが残る（最後のチャンクの応答が失われた再送に、同じ結果を返すため）
    expect([...t.store.values()].join()).not.toContain(SESSION_URL);
    expect([...t.store.values()].map((v) => JSON.parse(v))).toEqual([{ done: true, total: TOTAL, file: { id: 'NEWFILEID0123456789', name: '録音_1.m4a' } }]);
    expect(t.call('uploadChunk', token, 2 * KB256, chunkB64(last), TOTAL)).toEqual({ success: true, done: true, next: TOTAL, file: { id: 'NEWFILEID0123456789', name: '録音_1.m4a' } });
    expect(t.calls.fetch).toHaveLength(4);   // 再送でも Drive へは何も送らない
    // total が合わなければ、完了済みでも結果は返さない
    expect(t.call('uploadChunk', token, 0, chunkB64(10), TOTAL + 1).error).toMatch(/total/);
  });

  it('最後のチャンクの応答だけが失われて再送されても、完了済みの印があれば同じ結果を返す。abortUpload は印を消すだけで Drive に DELETE を送らない', () => {
    const t = mk([resp(200, { text: JSON.stringify({ id: 'NEWFILEID0123456789', name: 'a.m4a' }) })]);
    const { token } = t.call('beginUpload', { folderId: FOLDER, name: 'a.m4a', size: 100 });
    const first = t.call('uploadChunk', token, 0, chunkB64(100), 100);
    expect(first.done).toBe(true);
    expect(t.call('uploadChunk', token, 0, chunkB64(100), 100)).toEqual(first);
    expect(t.call('abortUpload', token)).toEqual({ success: true });
    expect(t.calls.fetch).toHaveLength(2);   // 開始 + 送信だけ
    expect(t.store.size).toBe(0);
    expect(t.call('uploadChunk', token, 0, chunkB64(100), 100).error).toMatch(/セッション/);
  });

  it('UrlFetchApp が例外を投げた（Drive が受け取ったか不明）あとの再送は、同じ位置への PUT を繰り返さず、先に Drive へ状態を問い合わせる', () => {
    const t = mk([
      () => { throw new Error('Exception: Timeout: https://www.googleapis.com/upload/drive/v3/files'); },
      // 再送: 状態問い合わせ → Drive は 1 チャンク分を受信済みと答える（例外の前に保存されていた）
      (url, opts) => { expect(opts.headers['Content-Range']).toBe(`bytes */${TOTAL}`); return resp(308, { headers: { Range: `bytes=0-${KB256 - 1}` } }); },
      resp(308, { headers: { Range: `bytes=0-${2 * KB256 - 1}` } }),
    ]);
    const { token } = begin(t);
    const failed = t.call('uploadChunk', token, 0, chunkB64(KB256), TOTAL);
    expect(failed).toMatchObject({ retryable: true });
    expect(failed.error).toContain('Timeout');
    expect(JSON.parse([...t.store.values()][0]).next).toBe(-1);
    // 同じ offset の再送: データは送り直さず、next だけ返す
    expect(t.call('uploadChunk', token, 0, chunkB64(KB256), TOTAL)).toEqual({ success: true, done: false, next: KB256 });
    expect(t.calls.fetch).toHaveLength(3);   // 開始 + 送信(例外) + 状態問い合わせ
    expect(t.call('uploadChunk', token, KB256, chunkB64(KB256), TOTAL)).toEqual({ success: true, done: false, next: 2 * KB256 });
  });

  it('保存名が 150 文字を超えるときは、拡張子を残して切り詰める（拡張子が切れると MIME を決められず保存できなくなる）', () => {
    const t = mk();
    const r = begin(t, { folderId: FOLDER, name: 'あ'.repeat(200) + '.m4a', size: 10 });
    expect(r.success).toBe(true);
    const sent = JSON.parse(t.calls.fetch[0][1].payload);
    expect(sent.name).toHaveLength(150);
    expect(sent.name.endsWith('.m4a')).toBe(true);
    expect(sent.mimeType).toBe('audio/mp4');
    // 拡張子が無い・極端に長い拡張子は従来どおり（拡張子が許可リストに無ければ断る）
    expect(begin(mk(), { folderId: FOLDER, name: 'あ'.repeat(200), size: 10 }).error).toBeTruthy();
    expect(begin(mk(), { folderId: FOLDER, name: 'a'.repeat(200) + '.' + 'x'.repeat(30), size: 10 }).error).toBeTruthy();
  });

  it('256 KiB の倍数でない途中チャンク、範囲外、total 不一致、空は拒否（Drive へ送らない）', () => {
    const t = mk();
    const { token } = begin(t);
    const sent = () => t.calls.fetch.length;
    const base = sent();
    for (const a of [
      [token, 0, chunkB64(KB256 - 1), TOTAL],       // 途中チャンクが 256 KiB の倍数でない
      [token, 0, chunkB64(KB256 + 1), TOTAL],
      [token, 0, '', TOTAL],                          // 空
      [token, 2 * KB256, chunkB64(KB256 + 200), TOTAL], // 総サイズを超える
      [token, TOTAL, chunkB64(10), TOTAL],            // offset が total 以上
      [token, -1, chunkB64(KB256), TOTAL],
      [token, 1.5, chunkB64(KB256), TOTAL],
      [token, 0, chunkB64(KB256), TOTAL + 1],         // total がセッションと不一致
      [token, 0, chunkB64(KB256), 'x'],
    ]) {
      const r = t.call('uploadChunk', ...a);
      expect(r.error, JSON.stringify(a.slice(1, 2)) + String(a[3])).toBeTruthy();
      expect(r.retryable).toBeUndefined();
    }
    expect(sent()).toBe(base);
    // 最終チャンクだけは 256 KiB の倍数でなくてよい
    const small = mk([resp(200, { text: JSON.stringify({ id: 'NEWFILEID0123456789', name: 'a.mp3' }) })]);
    const tok = small.call('beginUpload', { folderId: FOLDER, name: 'a.mp3', size: 100 }).token;
    expect(small.call('uploadChunk', tok, 0, chunkB64(100), 100).done).toBe(true);
  });

  it('応答が失われた場合の再送: offset がサーバーの記録と食い違うと Drive に状態を問い合わせ、next を返す（データは再送しない）', () => {
    const t = mk([
      resp(308, { headers: { Range: `bytes=0-${KB256 - 1}` } }),
      // 2 回目: 送ったが応答が 500 → セッションは「状態不明」
      resp(500, { text: 'oops' }),
      // 再送（offset KB256）→ 状態問い合わせ: Drive は 2*KB256 まで受信済みと答える
      (url, opts) => { expect(opts.headers['Content-Range']).toBe(`bytes */${TOTAL}`); expect(opts.payload).toBe(''); expect(opts.followRedirects).toBe(false); return resp(308, { headers: { Range: `bytes=0-${2 * KB256 - 1}` } }); },
      resp(200, { text: JSON.stringify({ id: 'NEWFILEID0123456789', name: 'a.m4a' }) }),
    ]);
    const { token } = begin(t);
    expect(t.call('uploadChunk', token, 0, chunkB64(KB256), TOTAL).next).toBe(KB256);
    const failed = t.call('uploadChunk', token, KB256, chunkB64(KB256), TOTAL);
    expect(failed).toMatchObject({ retryable: true });
    expect(failed.error).toContain('500');
    const again = t.call('uploadChunk', token, KB256, chunkB64(KB256), TOTAL);
    expect(again).toEqual({ success: true, done: false, next: 2 * KB256 });
    expect(t.calls.fetch).toHaveLength(4);    // 開始 + 送信 + 送信(500) + 状態問い合わせ（再送のデータ送信はない）
    expect(t.call('uploadChunk', token, 2 * KB256, chunkB64(TOTAL - 2 * KB256), TOTAL).done).toBe(true);
  });

  it('状態を問い合わせたら実は完了していた場合は done: true とファイルを返す。セッションの期限切れ（404）は retryable なしのエラー', () => {
    const t = mk([resp(200, { text: JSON.stringify({ id: 'NEWFILEID0123456789', name: 'a.m4a' }) })]);
    const { token } = begin(t);
    // 先に進んでいる前提のオフセットを送る（サーバーの記録は 0）
    const r = t.call('uploadChunk', token, KB256, chunkB64(KB256), TOTAL);
    expect(r).toEqual({ success: true, done: true, next: TOTAL, file: { id: 'NEWFILEID0123456789', name: 'a.m4a' } });
    expect([...t.store.values()].join()).not.toContain(SESSION_URL);   // URL は捨て、完了済みの印だけ残す

    const t2 = mk([resp(404)]);
    const tok = begin(t2).token;
    const e = t2.call('uploadChunk', tok, 0, chunkB64(KB256), TOTAL);
    expect(e.error).toMatch(/期限/);
    expect(e.retryable).toBeUndefined();
  });

  it('308 を「リダイレクト」として追従しない（followRedirects:false を毎回付ける）', () => {
    const t = mk([resp(308, { headers: { Range: `bytes=0-${KB256 - 1}` } })]);
    const { token } = begin(t);
    t.call('uploadChunk', token, 0, chunkB64(KB256), TOTAL);
    expect(t.calls.fetch.slice(1).every(([, o]) => o.followRedirects === false)).toBe(true);
  });

  it('不正なトークン', () => {
    const t = mk();
    for (const tok of ['', 'short', "../../etc/passwd-0123456789", 'x'.repeat(100), null, undefined, 'FAKE-TOKEN-0123456789-NOT-IN-CACHE']) {
      expect(t.call('uploadChunk', tok, 0, chunkB64(10), 10).error, String(tok)).toBeTruthy();
      expect(t.call('abortUpload', tok).success && tok !== 'FAKE-TOKEN-0123456789-NOT-IN-CACHE').toBeFalsy();
    }
    // 存在しないがトークンの形は正しい: 取り消しは成功扱い（既に無いものを消す）
    expect(t.call('abortUpload', 'FAKE-TOKEN-0123456789-NOT-IN-CACHE')).toEqual({ success: true });
    expect(t.calls.fetch).toEqual([]);
  });

  it('abortUpload: セッションを破棄し、Drive 側に DELETE（失敗しても成功扱い）', () => {
    const t = mk([resp(499)]);
    const { token } = begin(t);
    expect(t.call('abortUpload', token)).toEqual({ success: true });
    const [url, opts] = t.calls.fetch[1];
    expect(url).toBe(SESSION_URL);
    expect(opts.method).toBe('delete');
    expect(t.store.size).toBe(0);
    const t2 = mk([() => { throw new Error('network'); }]);
    const tok = begin(t2).token;
    expect(t2.call('abortUpload', tok)).toEqual({ success: true });
    expect(t2.store.size).toBe(0);
  });

  it('既存ファイルを上書き・削除・移動する関数も経路も無い（Drive への書き込みは create と resumable POST だけ）', () => {
    expect(SOURCE).not.toMatch(/Drive\.Files\.(update|remove|delete|copy|emptyTrash|trash)\b/);
    expect(SOURCE).not.toMatch(/setTrashed|moveTo|setName|\.makeCopy|addParents|removeParents/);
    expect(SOURCE).not.toMatch(/method:\s*'patch'/);
    expect(publicFunctions.filter((n) => /overwrite|rename|trash|delete|remove|move|copy|update/i.test(n))).toEqual([]);
    // Drive.Files.create はフォルダの新規作成の 1 か所だけ
    expect(SOURCE.match(/Drive\.Files\.create\(/g)).toHaveLength(1);
    // OAuth トークンを戻り値に使わない: getOAuthToken の呼び出しは driveAuth_ の 1 か所だけ
    const code = SOURCE.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    expect(code.match(/getOAuthToken\(\)/g)).toHaveLength(1);
    expect(code).toMatch(/function driveAuth_\(\) \{\n  return \{ Authorization: 'Bearer ' \+ ScriptApp\.getOAuthToken\(\) \};/);
  });
});
