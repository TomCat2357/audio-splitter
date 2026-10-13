import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DriveModal } from './components/DriveModal';
import { FileSection, type DownloadState, type ProbeState } from './components/FileSection';
import { OutputSettings, type OutputState } from './components/OutputSettings';
import { PlayerPanel } from './components/PlayerPanel';
import { Results, type ResultItem, type SaveState } from './components/Results';
import { RunPanel, type RunState } from './components/RunPanel';
import { SplitPanel } from './components/SplitPanel';
import { useDriveEnabled } from './hooks/useDriveEnabled';
import { useObjectUrl } from './hooks/useObjectUrl';
import { usePlayer } from './hooks/usePlayer';
import { useShortcuts } from './hooks/useShortcuts';
import { abortError, downloadDriveFile, isAbort, uniqueName, uploadToDrive } from './lib/driveTransfer';
import { DriveTransferError, type DriveFolder, type DriveItem, type ListFolderResult } from './lib/driveTypes';
import { isAbortError, probeFile, runJob } from './lib/engine';
import { gasCall, isGasError } from './lib/gas';
import { estimateOutputBytesPerSec, formatTime } from './lib/plan';
import {
  DEFAULT_VALUES,
  buildPlan,
  displayPointsFor,
  runLabel,
  segmentRows,
  validateSettings,
  type SplitMode,
  type SplitValues,
} from './lib/split';
import { createStore } from './lib/store';
import { addPoint, removePointAt, replacePoint } from './lib/timeline';
import type { AudioInfo, JobProgress, OutputSpec } from './lib/types';
import { zipParts } from './lib/zip';

type Notice = { text: string; tone: 'info' | 'warn' };

/** Drive から開いたファイルの出どころ（保存先の最初の表示位置に使う） */
type DriveSource = { fileId: string; parentId: string | null };

const DEFAULT_OUTPUT: OutputState = { kind: 'copy', format: 'm4a', bitrateKbps: 64, mono: false };

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<AudioInfo | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const probeToken = useRef(0);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const driveEnabled = useDriveEnabled();
  const [driveSource, setDriveSource] = useState<DriveSource | null>(null);
  const [driveModal, setDriveModal] = useState<'load' | 'save' | null>(null);
  const [download, setDownload] = useState<DownloadState>({ status: 'idle' });
  const downloadAbort = useRef<AbortController | null>(null);
  const lastDownloadItem = useRef<DriveItem | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  const saveAbort = useRef<AbortController | null>(null);

  const inputUrl = useObjectUrl(file);
  const duration = info?.durationSec ?? 0;
  const player = usePlayer(inputUrl, duration);

  const [mode, setMode] = useState<SplitMode>('interval');
  const [values, setValues] = useState<SplitValues>(DEFAULT_VALUES);
  const [manualPoints, setManualPoints] = useState<number[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [output, setOutput] = useState<OutputState>(DEFAULT_OUTPUT);

  const [runState, setRunState] = useState<RunState>({ status: 'idle' });
  const progress = useMemo(() => createStore<JobProgress | null>(null), []);
  const abortRef = useRef<AbortController | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  const resultsRef = useRef<ResultItem[]>([]);
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const running = runState.status === 'running';
  const downloading = download.status === 'downloading';
  const saving = saveState.status === 'saving';
  // 分割の実行中・Drive との転送中は、ファイルの読み込みや設定の変更、実行を受け付けない
  const busy = running || downloading || saving;

  // ---- 結果の管理（object URL は不要になったら必ず revoke） ----
  const clearResults = useCallback(() => {
    resultsRef.current.forEach((r) => URL.revokeObjectURL(r.url));
    resultsRef.current = [];
    setResults([]);
    setZipError(null);
    setSaveState({ status: 'idle' });
  }, []);

  useEffect(
    () => () => {
      resultsRef.current.forEach((r) => URL.revokeObjectURL(r.url));
      resultsRef.current = [];
      downloadAbort.current?.abort();
      saveAbort.current?.abort();
    },
    [],
  );

  // ---- ファイル読み込み ----
  const loadFile = useCallback(
    async (f: File, source: DriveSource | null = null) => {
      const token = ++probeToken.current;
      clearResults();
      setDriveSource(source);
      setRunState({ status: 'idle' });
      setInfo(null);
      setFile(null);
      setNotice(null);
      setProbe({ status: 'probing' });
      setPendingName(f.name);
      try {
        const i = await probeFile(f);
        if (token !== probeToken.current) return;
        setInfo(i);
        setFile(f);
        setMode('interval');
        setValues(DEFAULT_VALUES);
        setManualPoints([]);
        setOutput({ ...DEFAULT_OUTPUT, kind: i.copyFormat ? 'copy' : 'encode' });
        setProbe({ status: 'idle' });
      } catch (e) {
        if (token !== probeToken.current) return;
        setProbe({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
    [clearResults],
  );

  // ---- ウィンドウ全体へのドラッグ＆ドロップ ----
  const dropRef = useRef({ loadFile, busy });
  dropRef.current = { loadFile, busy };
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f && !dropRef.current.busy) void dropRef.current.loadFile(f);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // ---- 出力・分割の導出値 ----
  const outputSpec: OutputSpec = useMemo(
    () =>
      output.kind === 'copy'
        ? { kind: 'copy' }
        : { kind: 'encode', format: output.format, bitrate: output.bitrateKbps * 1000, mono: output.mono },
    [output],
  );
  const bytesPerSec = info ? estimateOutputBytesPerSec(info, outputSpec) : 0;
  const settingsError = info ? validateSettings(mode, values, duration, bytesPerSec) : null;
  const points = useMemo(
    () => (info ? displayPointsFor(mode, manualPoints, values, duration, bytesPerSec) : []),
    [info, mode, manualPoints, values, duration, bytesPerSec],
  );
  const rows = useMemo(() => segmentRows(points, duration, bytesPerSec), [points, duration, bytesPerSec]);
  const totalBytes = bytesPerSec * duration;

  // ---- 分割点の編集 ----
  const onMovePoint = useCallback((i: number, sec: number) => {
    setManualPoints((prev) => {
      if (prev[i] === sec) return prev;
      const next = prev.slice();
      next[i] = sec;
      return next;
    });
  }, []);

  const onRemovePoint = useCallback((i: number) => {
    setManualPoints((prev) => removePointAt(prev, i));
    setNotice(null);
  }, []);

  const onCommitPoint = (i: number, sec: number): boolean => {
    const next = replacePoint(manualPoints, i, sec, duration);
    if (!next) {
      setNotice({ text: 'その時刻には動かせません（端や他の分割点に近すぎます）。', tone: 'warn' });
      return false;
    }
    setManualPoints(next);
    setNotice(null);
    return true;
  };

  const changeMode = (m: SplitMode) => {
    setMode(m);
    setNotice(null);
  };

  const handoverToManual = (base: number[], addAt?: number) => {
    let next = base;
    if (addAt !== undefined) {
      const added = addPoint(base, addAt, duration);
      if (!added) {
        setNotice({ text: 'この位置には分割点を追加できません（端や他の分割点に近すぎます）。', tone: 'warn' });
        return;
      }
      next = added;
    }
    const fromAuto = mode !== 'manual' && mode !== 'none';
    setManualPoints(next);
    setMode('manual');
    setNotice({
      text: fromAuto
        ? '自動の分割点を引き継いで、手動モードに切り替えました。マーカーをドラッグしたり、分割点を追加・削除したりできます。'
        : '手動モードに切り替えました。',
      tone: 'info',
    });
  };

  const splitHere = () => {
    if (!info || busy) return;
    const t = player.timeStore.get();
    if (mode === 'manual') {
      const next = addPoint(manualPoints, t, duration);
      if (!next) {
        setNotice({ text: 'この位置には分割点を追加できません（端や他の分割点に近すぎます）。', tone: 'warn' });
        return;
      }
      setManualPoints(next);
      setNotice({ text: `${formatTime(t, { fraction: true })} に分割点を追加しました。`, tone: 'info' });
    } else {
      handoverToManual(points, t);
    }
  };

  useShortcuts({ enabled: info !== null, onTogglePlay: player.toggle, onSplit: splitHere });

  // ---- 実行 ----
  const outputUnavailable =
    info !== null &&
    ((output.kind === 'copy' && !info.copyFormat) || (output.kind === 'encode' && !info.canDecode));
  const runDisabled = !info || !file || settingsError !== null || outputUnavailable || busy;
  const disabledReason = settingsError
    ? settingsError
    : outputUnavailable
      ? 'この音声は、このブラウザでは書き出せる方法がありません。Chrome か Edge で開いてください。'
      : null;

  const startRun = async () => {
    if (!info || !file || running || runDisabled) return;
    clearResults();
    const ac = new AbortController();
    abortRef.current = ac;
    progress.set(null);
    setRunState({ status: 'running' });
    const plan = buildPlan(mode, values, points);
    try {
      const parts = await runJob(file, info, plan, outputSpec, {
        signal: ac.signal,
        onProgress: (p) => progress.set(p),
        onPart: (part) => {
          const item = { part, url: URL.createObjectURL(part.blob) };
          resultsRef.current = [...resultsRef.current, item];
          setResults(resultsRef.current);
        },
      });
      // サイズ上限ではファイル名が完了時に確定し直されるので、戻り値を正として表示を更新する
      const byPart = new Map(resultsRef.current.map((r) => [r.part, r.url]));
      resultsRef.current = parts.map((part) => ({ part, url: byPart.get(part) ?? URL.createObjectURL(part.blob) }));
      setResults(resultsRef.current);
      setRunState({ status: 'done', count: parts.length });
    } catch (e) {
      const count = resultsRef.current.length;
      if (isAbortError(e)) setRunState({ status: 'aborted', count });
      else setRunState({ status: 'error', message: e instanceof Error ? e.message : String(e), count });
    } finally {
      abortRef.current = null;
      progress.set(null);
    }
  };

  const cancelRun = () => abortRef.current?.abort();

  // ---- Google ドライブ ----
  const startDownload = async (item: DriveItem) => {
    if (busy) return;
    const ac = new AbortController();
    downloadAbort.current = ac;
    lastDownloadItem.current = item;
    let parentId: string | null = null;
    setDownload({ status: 'downloading', name: item.name, loaded: 0, total: item.size ?? 0 });
    try {
      const f = await downloadDriveFile(item.id, {
        signal: ac.signal,
        onInfo: (i) => {
          parentId = i.parentId;
          setDownload({ status: 'downloading', name: i.name, loaded: 0, total: i.size });
        },
        onProgress: (loaded, total) => setDownload({ status: 'downloading', name: item.name, loaded, total }),
      });
      downloadAbort.current = null;
      setDownload({ status: 'idle' });
      void loadFile(f, { fileId: item.id, parentId });
    } catch (e) {
      downloadAbort.current = null;
      if (isAbort(e)) setDownload({ status: 'aborted', name: item.name });
      else setDownload({ status: 'error', name: item.name, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const cancelDownload = () => downloadAbort.current?.abort();
  const retryDownload = () => {
    if (lastDownloadItem.current) void startDownload(lastDownloadItem.current);
  };

  const startSave = async (dest: DriveFolder) => {
    const items = resultsRef.current;
    if (busy || items.length === 0) return;
    const ac = new AbortController();
    saveAbort.current = ac;
    const total = items.length;
    const totalBytes = items.reduce((s, r) => s + r.part.blob.size, 0) || 1;
    const folder = { id: dest.id, name: dest.name };
    let saved = 0;
    setSaveState({ status: 'saving', index: 0, total, percent: 0, folderName: folder.name });
    try {
      // 同名を避けるため、保存先にあるファイル名を先に調べる
      const listed = await gasCall<ListFolderResult>('listFolder', dest.id);
      if (isGasError(listed)) throw new DriveTransferError(listed.error, listed.code);
      if (ac.signal.aborted) throw abortError();
      const names = new Set(listed.items.map((i) => i.name));
      let doneBytes = 0;
      for (let i = 0; i < total; i++) {
        const { part } = items[i];
        const name = uniqueName(names, part.fileName);
        names.add(name);
        await uploadToDrive(dest.id, name, part.blob, {
          signal: ac.signal,
          onProgress: (sent) =>
            setSaveState({
              status: 'saving',
              index: i,
              total,
              percent: Math.min(100, Math.round(((doneBytes + sent) / totalBytes) * 100)),
              folderName: folder.name,
            }),
        });
        doneBytes += part.blob.size;
        saved++;
      }
      setSaveState({ status: 'done', count: saved, folder });
    } catch (e) {
      if (isAbort(e)) setSaveState({ status: 'stopped', reason: 'aborted', saved, total, folder });
      else
        setSaveState({
          status: 'stopped',
          reason: 'error',
          message: e instanceof Error ? e.message : String(e),
          saved,
          total,
          folder,
        });
    } finally {
      saveAbort.current = null;
    }
  };

  const cancelSave = () => saveAbort.current?.abort();

  const saveZip = async () => {
    if (zipping || resultsRef.current.length === 0) return;
    setZipping(true);
    setZipError(null);
    try {
      const blob = await zipParts(resultsRef.current.map((r) => r.part));
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = `${stemOf(info?.fileName ?? 'audio')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60_000);
    } catch (e) {
      setZipError(`ZIP を作成できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setZipping(false);
    }
  };

  const partCount = rows.length;

  return (
    <div className="app">
      <header className="app-header">
        <h1>音声分割</h1>
        <p data-testid="header-note">
          {driveEnabled
            ? '音声の処理はすべてこのブラウザの中で行います。Google ドライブから開く・保存するときだけ、あなたの Google ドライブと通信します。'
            : 'ファイルはこの端末の中だけで処理され、外部には送信されません。'}
        </p>
      </header>

      <main>
        <FileSection
          info={info}
          probe={probe}
          fileName={pendingName}
          locked={busy}
          onFile={(f) => void loadFile(f)}
          drive={
            driveEnabled
              ? {
                  download,
                  onOpen: () => setDriveModal('load'),
                  onCancel: cancelDownload,
                  onRetry: retryDownload,
                }
              : null
          }
        />

        {info && (
          <>
            <PlayerPanel
              player={player}
              duration={duration}
              points={points}
              editable={mode === 'manual' && !busy}
              locked={busy}
              notice={notice}
              onSplitHere={splitHere}
              onMovePoint={onMovePoint}
              onRemovePoint={onRemovePoint}
            />
            <SplitPanel
              mode={mode}
              onMode={changeMode}
              values={values}
              onValues={setValues}
              error={settingsError}
              points={points}
              rows={rows}
              locked={busy}
              onAdjustManually={() => handoverToManual(points)}
              onCommitPoint={onCommitPoint}
              onRemovePoint={onRemovePoint}
              onClearPoints={() => {
                setManualPoints([]);
                setNotice(null);
              }}
              onSeek={player.seek}
              onSeekAndPlay={(sec) => {
                player.seek(sec);
                if (!player.playing) player.toggle();
              }}
            />
            <OutputSettings info={info} value={output} onChange={setOutput} locked={busy} totalBytes={totalBytes} />
            <RunPanel
              label={runLabel(mode, partCount, output.kind === 'encode')}
              disabled={runDisabled}
              disabledReason={disabledReason}
              state={runState}
              progress={progress}
              exactCount={mode !== 'maxSize'}
              onRun={() => void startRun()}
              onCancel={cancelRun}
            />
            <Results
              items={results}
              zipping={zipping}
              zipError={zipError}
              onZip={() => void saveZip()}
              drive={
                driveEnabled
                  ? {
                      state: saveState,
                      disabled: running || downloading,
                      onSave: () => setDriveModal('save'),
                      onCancel: cancelSave,
                    }
                  : null
              }
            />
          </>
        )}
      </main>

      {driveModal === 'load' && (
        <DriveModal
          mode="load"
          onClose={() => setDriveModal(null)}
          onPickFile={(item) => {
            setDriveModal(null);
            void startDownload(item);
          }}
        />
      )}
      {driveModal === 'save' && (
        <DriveModal
          mode="save"
          initialFolderId={driveSource?.parentId}
          onClose={() => setDriveModal(null)}
          onPickFolder={(folder) => {
            setDriveModal(null);
            void startSave(folder);
          }}
        />
      )}

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <p>ここにドロップして読み込む</p>
        </div>
      )}
    </div>
  );
}
