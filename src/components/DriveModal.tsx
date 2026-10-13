import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  PLACES,
  buildCrumbs,
  classifyInput,
  emptyText,
  formatDate,
  getLastFolder,
  isVirtualId,
  kindOf,
  placeOf,
  setLastFolder,
} from '../lib/drivePlaces';
import type {
  DriveFolder,
  DriveItem,
  FolderPathResult,
  GasError,
  ListFolderResult,
  ResolveResult,
  SearchResult,
} from '../lib/driveTypes';
import { gasCall, isGasError } from '../lib/gas';
import { formatBytes } from '../lib/plan';

const SEARCH_DELAY_MS = 350;
const RESTRICTED_TEXT = '所有者がダウンロードを禁止しています';

interface Props {
  mode: 'load' | 'save';
  /** 最初に開くフォルダ。省略時は最後に開いたフォルダ、それも無ければマイドライブ */
  initialFolderId?: string | null;
  onClose: () => void;
  /** load: ファイルを確定 */
  onPickFile?: (item: DriveItem) => void;
  /** save: 保存先のフォルダを確定 */
  onPickFolder?: (folder: DriveFolder) => void;
}

type View = { folder: DriveFolder | null; items: DriveItem[]; query: string | null; truncated: boolean };
type ErrorState = { message: string; retry: (() => void) | null };

const EMPTY_VIEW: View = { folder: null, items: [], query: null, truncated: false };

function errText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  return `通信に失敗しました。${raw ? `（${raw}）` : ''}`;
}

// ---- 素朴なインライン SVG アイコン ----
function Icon({ name }: { name: string }): ReactNode {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (name) {
    case 'folder':
      return (
        <svg {...common}>
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
        </svg>
      );
    case 'audio':
      return (
        <svg {...common}>
          <path d="M9 18V6l10-2v12" />
          <circle cx="6.5" cy="18" r="2.5" />
          <circle cx="16.5" cy="16" r="2.5" />
        </svg>
      );
    case 'video':
      return (
        <svg {...common}>
          <rect x="3" y="6" width="13" height="12" rx="2" />
          <path d="m16 10 5-3v10l-5-3z" />
        </svg>
      );
    case 'my-drive':
      return (
        <svg {...common}>
          <path d="M3 14h18v5H3z" />
          <path d="m5 14 2.5-8h9L19 14" />
          <circle cx="7" cy="16.5" r=".6" />
        </svg>
      );
    case 'shared-drives':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
          <path d="M16 6a3 3 0 0 1 0 6M18 14c1.8.6 3 2.2 3 5" />
        </svg>
      );
    case 'shared-with-me':
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
        </svg>
      );
    case 'starred':
      return (
        <svg {...common}>
          <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9-4.3-4.1 5.9-.8z" />
        </svg>
      );
    case 'recent':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-4.2-4.2" />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    default:
      return null;
  }
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function DriveModal({ mode, initialFolderId, onClose, onPickFile, onPickFolder }: Props) {
  const isSave = mode === 'save';
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [view, setView] = useState<View>(EMPTY_VIEW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorState | null>(null);
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [searchText, setSearchText] = useState('');
  const [pathInfo, setPathInfo] = useState<{ forId: string; path: { id: string; name: string }[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  // 古い応答が新しい表示を上書きしないための世代番号（フォルダ移動・検索・解決のすべてで共通）
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const lastFolderRef = useRef<string>('root');
  const creatingRef = useRef(false);
  creatingRef.current = creating;
  const mounted = useRef(true);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const listOptions = isSave ? { foldersOnly: true } : undefined;

  const loadFolder = useCallback(
    async (id: string, opts?: { initial?: boolean; notice?: string }): Promise<void> => {
      const mySeq = ++seq.current;
      clearTimer();
      setLoading(true);
      setError(null);
      setCreating(false);
      setSearchText('');
      try {
        const res = await gasCall<ListFolderResult>('listFolder', id, isSave ? { foldersOnly: true } : undefined);
        if (mySeq !== seq.current) return;
        if (isGasError(res)) {
          if (opts?.initial && id !== 'root') {
            await loadFolder('root', {
              notice: `前に開いたフォルダを開けませんでした（${res.error}）。マイドライブから選んでください。`,
            });
            return;
          }
          setError({ message: res.error, retry: () => void loadFolder(id) });
        } else {
          setView({ folder: res.folder, items: res.items ?? [], query: null, truncated: !!res.truncated });
          lastFolderRef.current = res.folder.id;
          setLastFolder(res.folder.id);
          if (opts?.notice) setError({ message: opts.notice, retry: null });
        }
      } catch (e) {
        if (mySeq !== seq.current) return;
        setError({ message: errText(e), retry: () => void loadFolder(id) });
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [isSave],
  );

  // 最初の表示
  useEffect(() => {
    mounted.current = true;
    void loadFolder(initialFolderId || getLastFolder() || 'root', { initial: true });
    return () => {
      mounted.current = false;
      seq.current++;
      clearTimer();
    };
    // 開いたときの 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // パンくずの上位（取れなくても一覧は使える）
  const folderId = view.folder?.id ?? null;
  useEffect(() => {
    if (!folderId || isVirtualId(folderId)) {
      setPathInfo(null);
      return;
    }
    let dead = false;
    gasCall<FolderPathResult>('getFolderPath', folderId).then(
      (r) => {
        if (dead) return;
        if (!isGasError(r) && r && Array.isArray(r.path)) setPathInfo({ forId: folderId, path: r.path });
        else setPathInfo(null);
      },
      () => {
        if (!dead) setPathInfo(null);
      },
    );
    return () => {
      dead = true;
    };
  }, [folderId]);

  const runSearch = useCallback(
    async (raw: string, auto: boolean): Promise<void> => {
      const term = raw.trim();
      clearTimer();
      if (!term) {
        if (viewRef.current.query !== null) void loadFolder(lastFolderRef.current || 'root');
        return;
      }
      const cls = classifyInput(term);
      // 入力が止まっただけのときは名前の検索だけ。URL / ID らしいものは Enter まで待つ
      if (auto && cls.kind !== 'none') return;
      if (!auto && cls.kind === 'place') {
        void loadFolder(cls.id);
        return;
      }
      const mySeq = ++seq.current;
      setLoading(true);
      setError(null);
      setCreating(false);
      try {
        if (!auto && cls.kind === 'drive') {
          let r: ResolveResult | GasError | null = null;
          try {
            r = await gasCall<ResolveResult>('resolveLocationInput', term);
          } catch {
            r = null;
          }
          if (mySeq !== seq.current) return;
          if (r && !isGasError(r)) {
            if (r.kind === 'folder') {
              await loadFolder(r.id);
              return;
            }
            if (isSave) {
              setError({ message: '保存先にはフォルダを指定してください。', retry: null });
              return;
            }
            if (!r.item.canDownload) {
              setError({ message: `「${r.item.name}」は${RESTRICTED_TEXT}。開けません。`, retry: null });
              return;
            }
            setSelected(r.item);
            if (r.parentId) {
              await loadFolder(r.parentId);
              return;
            }
            setSearchText('');
            return;
          }
          // 解決できなければ、名前の検索として扱う
        }
        const res = await gasCall<SearchResult>('searchDrive', term, listOptions);
        if (mySeq !== seq.current) return;
        if (isGasError(res)) {
          setError({ message: res.error, retry: () => void runSearch(term, false) });
        } else {
          setView({ folder: null, items: res.items ?? [], query: res.query || term, truncated: !!res.truncated });
        }
      } catch (e) {
        if (mySeq !== seq.current) return;
        setError({ message: errText(e), retry: () => void runSearch(term, false) });
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadFolder, isSave],
  );

  const onSearchChange = (v: string) => {
    setSearchText(v);
    clearTimer();
    timer.current = setTimeout(() => void runSearch(v, true), SEARCH_DELAY_MS);
  };

  const clearSearch = () => {
    setSearchText('');
    clearTimer();
    if (viewRef.current.query !== null) void loadFolder(lastFolderRef.current || 'root');
  };

  // ---- 確定 ----
  const folder = view.folder;
  const realFolder = !!folder && !isVirtualId(folder.id);
  const canSave = isSave && realFolder && folder!.canAddChildren;
  const saveBlock = !folder
    ? '保存先にするフォルダを開いてください。'
    : !realFolder
      ? 'ここには保存できません。マイドライブや共有ドライブのフォルダを開いてください。'
      : !folder.canAddChildren
        ? 'このフォルダには保存する権限がありません。'
        : '';
  const canOpen = !isSave && !!selected && selected.canDownload;

  const confirm = (item?: DriveItem) => {
    if (isSave) {
      if (canSave && folder) onPickFolder?.(folder);
      return;
    }
    const target = item ?? selected;
    if (target && target.canDownload) onPickFile?.(target);
  };

  const onRowActivate = (item: DriveItem, how: 'click' | 'enter' | 'dblclick') => {
    if (item.type === 'folder') {
      if (how !== 'dblclick') void loadFolder(item.id);
      return;
    }
    if (isSave || !item.canDownload) return;
    setSelected(item);
    if (how === 'dblclick' || how === 'enter') confirm(item);
  };

  const createNewFolder = async () => {
    const name = newName.trim();
    if (!name || !folder || !realFolder || creatingBusy) return;
    setCreatingBusy(true);
    setCreateError('');
    try {
      const res = await gasCall<{ success: true; id: string; name: string }>('createFolder', folder.id, name);
      if (!mounted.current) return;
      if (isGasError(res)) {
        setCreateError(res.error);
      } else {
        setNewName('');
        setCreating(false);
        await loadFolder(res.id);
      }
    } catch (e) {
      if (mounted.current) setCreateError(`フォルダを作れませんでした。${errText(e)}`);
    } finally {
      if (mounted.current) setCreatingBusy(false);
    }
  };

  // ---- フォーカス・スクロール・キー操作 ----
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus();
    };
  }, []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const dlg = dialogRef.current;
      if (!dlg) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (creatingRef.current) setCreating(false);
        else onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        dlg.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dlg.contains(active) || active === dlg) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // 一覧が入れ替わってフォーカスを失ったら、一覧へ戻す（検索欄などで入力中なら奪わない）
  useEffect(() => {
    const dlg = dialogRef.current;
    const active = document.activeElement;
    if (!dlg) return;
    if (active === document.body || active === dlg || !dlg.contains(active)) listRef.current?.focus();
  }, [view]);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    let to = -1;
    if (e.key === 'ArrowDown') to = i < 0 ? 0 : Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') to = i < 0 ? 0 : Math.max(0, i - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = rows.length - 1;
    if (to >= 0) {
      e.preventDefault();
      rows[to].focus();
      rows[to].scrollIntoView?.({ block: 'nearest' });
    }
  };

  // ---- 表示 ----
  const crumbs = buildCrumbs(folder, pathInfo && pathInfo.forId === folder?.id ? pathInfo.path : null);
  const searching = view.query !== null;
  const activePlace = folder ? placeOf(folder).key : null;
  const items = view.items;

  return createPortal(
    <div
      className="drive-overlay"
      data-testid="drive-modal-overlay"
      onKeyDown={(e) => e.stopPropagation()} // 背面の再生・分割のショートカットを動かさない
    >
      <div
        ref={dialogRef}
        className="drive-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid="drive-modal"
        data-mode={mode}
      >
        <div className="drive-head">
          <h2 id={titleId}>{isSave ? 'Google ドライブの保存先を選ぶ' : 'Google ドライブからファイルを選ぶ'}</h2>
          <div className="drive-search">
            <span className="drive-search-icon">
              <Icon name="search" />
            </span>
            <input
              type="text"
              value={searchText}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runSearch(searchText, false);
                }
              }}
              placeholder={isSave ? 'フォルダを検索、または URL を入力' : '名前で検索、または URL を入力'}
              aria-label="ドライブ内を検索（URL や ID も入力できます）"
              data-testid="drive-search"
            />
            {searchText && (
              <button type="button" className="drive-search-clear" onClick={clearSearch} aria-label="検索を消す" data-testid="drive-search-clear">
                ×
              </button>
            )}
          </div>
        </div>

        <div className="drive-body">
          <nav className="drive-places" aria-label="場所" data-testid="drive-places">
            {PLACES.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`drive-place${activePlace === p.key && !searching ? ' is-on' : ''}`}
                aria-current={activePlace === p.key && !searching ? 'true' : undefined}
                onClick={() => void loadFolder(p.id)}
                data-testid={`drive-place-${p.key}`}
              >
                <Icon name={p.key} />
                <span>{p.label}</span>
              </button>
            ))}
          </nav>

          <div className="drive-main">
            <div className="drive-crumbs" data-testid="drive-crumbs">
              {searching ? (
                <div className="drive-search-banner" data-testid="drive-search-banner">
                  <span>「{view.query}」の検索結果</span>
                  <button type="button" className="btn btn-sm" onClick={clearSearch} data-testid="drive-search-exit">
                    検索を解除
                  </button>
                </div>
              ) : (
                <ol className="drive-crumb-list" aria-label="いまの場所">
                  {crumbs.map((c, i) => (
                    <li key={`${c.id}:${i}`}>
                      {i > 0 && (
                        <span className="drive-crumb-sep" aria-hidden="true">
                          ›
                        </span>
                      )}
                      {c.current ? (
                        <span className="drive-crumb-current" aria-current="location" data-testid="drive-crumb-current">
                          {c.name}
                        </span>
                      ) : (
                        <button type="button" className="drive-crumb" onClick={() => void loadFolder(c.id)} data-testid="drive-crumb" title={c.name}>
                          {c.name}
                        </button>
                      )}
                    </li>
                  ))}
                  {crumbs.length === 0 && <li className="drive-crumb-current">読み込み中…</li>}
                </ol>
              )}
              {isSave && (
                <button
                  type="button"
                  className="btn btn-sm drive-new-folder"
                  onClick={() => {
                    setCreating(true);
                    setNewName('');
                    setCreateError('');
                  }}
                  disabled={!realFolder || !folder?.canAddChildren || creating}
                  title={realFolder && folder?.canAddChildren ? undefined : saveBlock}
                  data-testid="drive-new-folder"
                >
                  <Icon name="plus" /> 新しいフォルダ
                </button>
              )}
            </div>

            <div className="drive-list-wrap">
              {error && (
                <div className="msg msg-error drive-error" role="alert" data-testid="drive-error">
                  <span>{error.message}</span>
                  {error.retry && (
                    <button type="button" className="btn btn-sm" onClick={error.retry} data-testid="drive-retry">
                      もう一度試す
                    </button>
                  )}
                </div>
              )}

              {creating && (
                <div className="drive-newrow" data-testid="drive-new-folder-row">
                  <label>
                    <span className="drive-newrow-label">新しいフォルダの名前</span>
                    <input
                      type="text"
                      value={newName}
                      autoFocus
                      disabled={creatingBusy}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void createNewFolder();
                        }
                      }}
                      data-testid="drive-new-folder-input"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void createNewFolder()}
                    disabled={!newName.trim() || creatingBusy}
                    data-testid="drive-new-folder-ok"
                  >
                    {creatingBusy ? '作成中…' : '作成'}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setCreating(false)} disabled={creatingBusy} data-testid="drive-new-folder-cancel">
                    やめる
                  </button>
                  {createError && (
                    <p className="msg msg-error drive-newrow-error" role="alert" data-testid="drive-new-folder-error">
                      {createError}
                    </p>
                  )}
                </div>
              )}

              {loading && (
                <p className="drive-loading" role="status" data-testid="drive-loading">
                  読み込み中…
                </p>
              )}

              <div
                ref={listRef}
                className="drive-list"
                role="listbox"
                tabIndex={-1}
                aria-label={searching ? '検索結果' : 'フォルダの中身'}
                aria-busy={loading}
                onKeyDown={onListKey}
                data-testid="drive-list"
              >
                {items.map((item, idx) => {
                  const isFolder = item.type === 'folder';
                  const kind = kindOf(item);
                  const disabled = !isFolder && !item.canDownload;
                  const isSel = !isFolder && selected?.id === item.id;
                  return (
                    <div
                      key={`${item.id}:${idx}`}
                      role="option"
                      aria-selected={isFolder ? undefined : isSel}
                      aria-disabled={disabled || undefined}
                      tabIndex={idx === 0 ? 0 : -1}
                      className={`drive-row${isSel ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
                      data-testid="drive-item"
                      data-name={item.name}
                      data-kind={kind}
                      data-selected={isSel ? '1' : '0'}
                      data-disabled={disabled ? '1' : '0'}
                      onClick={() => onRowActivate(item, 'click')}
                      onDoubleClick={() => onRowActivate(item, 'dblclick')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          onRowActivate(item, 'enter');
                        } else if (e.key === ' ') {
                          e.preventDefault();
                          if (!isFolder && !disabled && !isSave) setSelected(item);
                          else if (isFolder) onRowActivate(item, 'click');
                        }
                      }}
                    >
                      <span className={`drive-row-icon kind-${kind}`}>
                        <Icon name={kind} />
                      </span>
                      <span className="drive-row-main">
                        <span className="drive-row-name" data-testid="drive-item-name">
                          {item.name}
                        </span>
                        {disabled && (
                          <span className="drive-row-sub drive-row-warn" data-testid="drive-item-restricted">
                            {RESTRICTED_TEXT}
                          </span>
                        )}
                      </span>
                      {isFolder ? (
                        <span className="drive-row-meta" aria-hidden="true">
                          ›
                        </span>
                      ) : (
                        <span className="drive-row-meta">
                          {item.size != null ? formatBytes(item.size) : ''}
                          {item.updated != null && <span className="drive-row-date"> ・ {formatDate(item.updated)}</span>}
                        </span>
                      )}
                    </div>
                  );
                })}
                {!loading && !error && items.length === 0 && (
                  <p className="drive-empty" data-testid="drive-empty">
                    {emptyText({ mode, searching, folderId: folder?.id })}
                  </p>
                )}
                {view.truncated && items.length > 0 && (
                  <p className="hint drive-truncated" data-testid="drive-truncated">
                    先頭の一部だけ表示しています。名前で絞り込むと見つけやすくなります。
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="drive-foot">
          <div className="drive-foot-info" aria-live="polite">
            {isSave ? (
              canSave ? (
                <p data-testid="drive-save-target">
                  保存先: <strong>{folder!.name}</strong>
                </p>
              ) : (
                <p className="drive-row-warn" data-testid="drive-save-block">
                  {saveBlock}
                </p>
              )
            ) : selected ? (
              <p data-testid="drive-selected">
                選んだファイル: <strong>{selected.name}</strong>
                {selected.size != null && `（${formatBytes(selected.size)}）`}
              </p>
            ) : (
              <p className="hint" data-testid="drive-selected">
                音声や動画のファイルを 1 つ選んでください。
              </p>
            )}
          </div>
          <div className="drive-foot-buttons">
            <button type="button" className="btn" onClick={onClose} data-testid="drive-cancel">
              キャンセル
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => confirm()}
              disabled={isSave ? !canSave : !canOpen}
              data-testid="drive-confirm"
            >
              {isSave ? 'このフォルダに保存' : '開く'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
