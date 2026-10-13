// 「場所」とパンくずの純粋ロジック（DOM 非依存）。

import type { DriveFolder, DriveItem } from './driveTypes';

export interface Place {
  /** data-testid などに使う安定した名前 */
  key: 'my-drive' | 'shared-drives' | 'shared-with-me' | 'starred' | 'recent';
  id: string;
  label: string;
}

export const PLACES: readonly Place[] = [
  { key: 'my-drive', id: 'root', label: 'マイドライブ' },
  { key: 'shared-drives', id: 'shared-root', label: '共有ドライブ' },
  { key: 'shared-with-me', id: 'shared-with-me', label: '共有アイテム' },
  { key: 'starred', id: 'starred', label: 'スター付き' },
  { key: 'recent', id: 'recent', label: '最近使ったもの' },
];

/** 実フォルダではなく、一覧だけを返す仮想フォルダ（ここには保存できない） */
const VIRTUAL_IDS = ['shared-root', 'shared-with-me', 'starred', 'recent'];

export function isVirtualId(id: string | null | undefined): boolean {
  return !!id && VIRTUAL_IDS.includes(id);
}

export function placeLabel(id: string): string | null {
  return PLACES.find((p) => p.id === id)?.label ?? null;
}

export interface Crumb {
  id: string;
  name: string;
  /** 末尾 = 表示中の場所（クリックしても動かない） */
  current: boolean;
}

/** 表示中のフォルダ（listFolder の folder）がどの場所に属するか */
export function placeOf(folder: Pick<DriveFolder, 'id' | 'driveId'> | null): Place {
  if (folder) {
    const v = PLACES.find((p) => p.id === folder.id);
    if (v) return v;
    if (folder.driveId) return PLACES[1];
  }
  return PLACES[0];
}

/**
 * パンくず。path は getFolderPath の結果（上位から自分まで）。取得できなかった（null / 空）ときは、
 * 表示中のフォルダ名だけを返す。表示中の名前は folder.name（path の末尾の名前より新しい）。
 * 仮想フォルダは、その場所の名前だけ。
 */
export function buildCrumbs(
  folder: Pick<DriveFolder, 'id' | 'name' | 'isRoot' | 'driveId'> | null,
  path: { id: string; name: string }[] | null | undefined,
): Crumb[] {
  if (!folder) return [];
  if (isVirtualId(folder.id)) return [{ id: folder.id, name: placeLabel(folder.id) ?? folder.name, current: true }];
  const segs = (path ?? []).filter((p) => p && p.id);
  const out: Crumb[] = segs.map((p) => ({ id: p.id, name: p.name || '', current: false }));
  if (out.length === 0) {
    out.push({ id: folder.id, name: folder.name, current: true });
  } else {
    const last = out[out.length - 1];
    out[out.length - 1] = { id: last.id, name: folder.name || last.name, current: true };
  }
  const isMyRoot = folder.id === 'root' || (folder.isRoot && !folder.driveId);
  if (isMyRoot || (segs.length > 0 && out[0].id === 'root' && !folder.driveId)) {
    out[0] = { id: 'root', name: PLACES[0].label, current: out[0].current }; // 実 ID のルートも 'root' に揃える
    return out;
  }
  if (folder.driveId) return [{ id: 'shared-root', name: PLACES[1].label, current: false }, ...out];
  return out;
}

/** 検索欄の入力を、Enter で解釈する前の分類 */
export type LocationInput =
  | { kind: 'none' }
  | { kind: 'place'; id: string } // 場所の名前だけ（マイドライブ など）や 'root'
  | { kind: 'drive'; text: string }; // URL か ID らしい（resolveLocationInput に渡す）

const PLACE_URL_RE =
  /^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?(my-drive|shared-drives|shared-with-me|starred|recent)(?:[/?#]|$)/i;
const PLACE_URL_IDS: Record<string, string> = {
  'my-drive': 'root',
  'shared-drives': 'shared-root',
  'shared-with-me': 'shared-with-me',
  starred: 'starred',
  recent: 'recent',
};

/** 検索欄の入力が Drive の場所を指していそうかを判定する（実際の解決はサーバー） */
export function classifyInput(raw: string): LocationInput {
  const s = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^[\s"'<]+|[\s"'>]+$/g, '');
  if (!s || s.length > 2048) return { kind: 'none' };
  const m = PLACE_URL_RE.exec(s);
  if (m) return { kind: 'place', id: PLACE_URL_IDS[m[1].toLowerCase()] };
  if (/^(https?:\/\/)?(drive|docs)\.google\.com\//i.test(s)) return { kind: 'drive', text: s };
  if (s === 'root') return { kind: 'place', id: 'root' };
  const byLabel = PLACES.find((p) => p.label === s);
  if (byLabel) return { kind: 'place', id: byLabel.id };
  // Drive の ID は英数字・ハイフン・アンダースコアの 20 文字前後。短い単語は検索として扱う
  if (/^[-\w]{20,}$/.test(s)) return { kind: 'drive', text: s };
  return { kind: 'none' };
}

/** 入力が URL / ID らしいか（入力が止まっただけでは検索せず、Enter を待つ判断に使う） */
export function looksLikeDriveInput(raw: string): boolean {
  return classifyInput(raw).kind !== 'none';
}

/** Drive のフォルダを Drive の画面で開く URL */
export function folderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

export type ItemKind = 'folder' | 'audio' | 'video' | 'file';

export function kindOf(item: Pick<DriveItem, 'type' | 'mimeType'>): ItemKind {
  if (item.type === 'folder') return 'folder';
  const mt = (item.mimeType || '').toLowerCase();
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  return 'file';
}

/** 一覧が空のときの文言 */
export function emptyText(opts: { mode: 'load' | 'save'; searching: boolean; folderId?: string | null }): string {
  if (opts.searching) return '一致するものはありません';
  if (opts.mode === 'save') return 'このフォルダにフォルダはありません';
  if (opts.folderId === 'shared-root') return '共有ドライブはありません';
  return 'このフォルダに音声ファイルはありません';
}

/** 更新日（ミリ秒）→ 表示用。null は空文字 */
export function formatDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

// ---------------------------------------------------------------- 最後に開いたフォルダ（同じ画面の間は保持。localStorage は任意）

const LAST_FOLDER_KEY = 'audio-split:drive-last-folder';
let lastFolderInMemory: string | null = null;

export function getLastFolder(): string | null {
  if (lastFolderInMemory) return lastFolderInMemory;
  try {
    const v = globalThis.localStorage?.getItem(LAST_FOLDER_KEY);
    if (v) {
      lastFolderInMemory = v;
      return v;
    }
  } catch {
    /* 保存できない環境（プライベートウィンドウなど）でも動く */
  }
  return null;
}

export function setLastFolder(id: string): void {
  lastFolderInMemory = id;
  try {
    globalThis.localStorage?.setItem(LAST_FOLDER_KEY, id);
  } catch {
    /* 無視 */
  }
}
