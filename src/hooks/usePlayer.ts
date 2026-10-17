import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clampRate } from '../lib/rate';
import { ReversePlayer } from '../lib/reverse';
import { createStore, type Store } from '../lib/store';
import { clamp, stepTime } from '../lib/timeline';

export interface Player {
  /** <audio> に展開して使う props */
  audioProps: React.AudioHTMLAttributes<HTMLAudioElement> & { ref: React.RefObject<HTMLAudioElement | null> };
  /** 現在位置（秒）。再生中は rAF で更新される。購読した部品だけが再レンダリングされる。 */
  timeStore: Store<number>;
  playing: boolean;
  /** ブラウザがこの形式を再生できない */
  unplayable: boolean;
  /** 再生速度の倍率（0.25〜4）。順再生・逆再生どちらにも効き、ピッチは保たれる */
  rate: number;
  setRate: (r: number) => void;
  /** 現在の速度に delta を足す（範囲内に収める） */
  stepRate: (delta: number) => void;
  resetRate: () => void;
  /** 逆再生（方向のトグル。速度は常に正の値のまま） */
  reverse: boolean;
  setReverse: (on: boolean) => void;
  /** 逆再生を使えるか（デコードできて、順再生もできる） */
  canReverse: boolean;
  /** 逆再生に失敗したときのメッセージ */
  reverseError: string | null;
  seek: (sec: number) => void;
  skip: (deltaSec: number) => void;
  toggle: () => void;
}

/** 逆再生で使う入力。デコードできないファイルでは null */
export interface ReverseSource {
  file: File;
  sampleRate: number;
}

/** 逆再生中にシークや速度変更が連続したとき、鳴らし直すまで待つ時間（ミリ秒） */
const REVERSE_RESTART_MS = 80;

/**
 * 再生まわりをまとめる。全体の長さは audio.duration ではなく durationSec（info.durationSec）を使う。
 * 再生できない形式でも seek は現在位置ストアを更新するので、分割点の指定は続けられる。
 *
 * 順再生は <audio>、逆再生は Web Audio（lib/reverse.ts）で鳴らす。どちらの方向でも
 * 再生/停止・シーク・±秒・速度変更は同じ関数で扱い、位置は timeStore に集約する。
 * 順⇔逆の切り替えは現在位置から続ける。
 */
export function usePlayer(url: string | null, durationSec: number, reverseSource: ReverseSource | null = null): Player {
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeStore = useMemo(() => createStore(0), []);
  const [playing, setPlayingState] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [rate, setRateState] = useState(1);
  const [reverse, setReverseState] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const reverseRef = useRef(false);
  const unplayableRef = useRef(false);
  const revRef = useRef<ReversePlayer | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPlaying = useCallback((v: boolean) => {
    playingRef.current = v;
    setPlayingState(v);
  }, []);

  const clearRestart = () => {
    if (restartTimer.current !== null) {
      clearTimeout(restartTimer.current);
      restartTimer.current = null;
    }
  };

  useEffect(() => {
    timeStore.set(0);
    setPlaying(false);
    setUnplayable(false);
    unplayableRef.current = false;
    reverseRef.current = false;
    setReverseState(false);
    setReverseError(null);
  }, [url, timeStore, setPlaying]);

  // ファイルが変わったら逆再生の部品を捨てる（AudioContext と mediabunny の Input を解放する）
  useEffect(
    () => () => {
      clearRestart();
      revRef.current?.dispose();
      revRef.current = null;
    },
    [reverseSource],
  );

  // 再生中だけ rAF で位置を読み、ストア経由で必要な部品だけ更新する
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      if (reverseRef.current) {
        const r = revRef.current;
        // 鳴らし直しの待ち中（isActive が false）は、シークした位置をそのまま見せる
        if (r?.isActive) {
          if (r.finished) {
            r.stop();
            timeStore.set(0);
            setPlaying(false);
            return;
          }
          timeStore.set(clamp(r.position(), 0, durationSec));
        }
      } else {
        const a = audioRef.current;
        if (a) timeStore.set(clamp(a.currentTime, 0, durationSec));
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, durationSec, timeStore, setPlaying]);

  // ---- 逆再生の下請け ----
  const failReverse = useCallback(
    (message: string) => {
      clearRestart();
      reverseRef.current = false;
      setReverseState(false);
      setReverseError(message);
      const pos = timeStore.get();
      const a = audioRef.current;
      if (a && !unplayableRef.current) {
        try {
          a.currentTime = pos;
        } catch {
          // メタデータ未読み込みなどは無視
        }
      }
      setPlaying(false);
    },
    [timeStore, setPlaying],
  );

  const startReverse = useCallback(
    (from: number) => {
      if (!reverseSource) return;
      revRef.current ??= new ReversePlayer(reverseSource.file, reverseSource.sampleRate, { onError: failReverse });
      void revRef.current.start(from, rateRef.current);
    },
    [reverseSource, failReverse],
  );

  /** 逆再生中に位置や速度が変わったとき。いったん止め、連続する変更が落ち着いてから鳴らし直す */
  const restartReverseSoon = useCallback(() => {
    clearRestart();
    restartTimer.current = setTimeout(() => {
      restartTimer.current = null;
      if (reverseRef.current && playingRef.current) startReverse(timeStore.get());
    }, REVERSE_RESTART_MS);
  }, [startReverse, timeStore]);

  const seek = useCallback(
    (sec: number) => {
      const s = clamp(sec, 0, Math.max(0, durationSec));
      timeStore.set(s);
      // 逆再生中も <audio> の位置は合わせておく（順再生に戻すとき、その位置から続けられる）
      const a = audioRef.current;
      if (a && !unplayableRef.current) {
        try {
          a.currentTime = s;
        } catch {
          // メタデータ未読み込みなどは無視
        }
      }
      if (reverseRef.current && playingRef.current) {
        revRef.current?.stop();
        restartReverseSoon();
      }
    },
    [durationSec, timeStore, restartReverseSoon],
  );

  const skip = useCallback(
    (delta: number) => seek(stepTime(timeStore.get(), delta, durationSec)),
    [seek, timeStore, durationSec],
  );

  const toggle = useCallback(() => {
    if (reverseRef.current) {
      if (playingRef.current) {
        clearRestart();
        // 鳴らし直しの待ち中（isActive が false）に止めたときは、シークした位置のまま
        const r = revRef.current;
        if (r?.isActive) timeStore.set(clamp(r.stop(), 0, durationSec));
        setPlaying(false);
      } else {
        // 先頭では逆に進めないので、末尾から始める
        let from = timeStore.get();
        if (from <= 0.05) from = durationSec;
        timeStore.set(from);
        setPlaying(true);
        startReverse(from);
      }
      return;
    }
    const a = audioRef.current;
    if (!a || unplayableRef.current) return;
    if (a.paused) {
      if (a.ended || timeStore.get() >= durationSec - 0.05) seek(0);
      a.play().catch(() => {
        // 失敗時は error イベントで通知される
      });
    } else {
      a.pause();
    }
  }, [seek, timeStore, durationSec, setPlaying, startReverse]);

  const setReverse = useCallback(
    (on: boolean) => {
      if (on === reverseRef.current) return;
      if (on && (!reverseSource || unplayableRef.current)) return;
      const was = playingRef.current;
      const a = audioRef.current;
      if (on) {
        // 順 → 逆。いまの位置から逆向きに続ける
        const pos = timeStore.get();
        reverseRef.current = true;
        setReverseState(true);
        setReverseError(null);
        if (was) {
          a?.pause();
          startReverse(pos);
        }
      } else {
        // 逆 → 順
        clearRestart();
        const r = revRef.current;
        const pos = r?.isActive ? clamp(r.stop(), 0, durationSec) : timeStore.get();
        reverseRef.current = false;
        setReverseState(false);
        timeStore.set(pos);
        if (a && !unplayableRef.current) {
          try {
            a.currentTime = pos;
          } catch {
            // メタデータ未読み込みなどは無視
          }
          if (was) a.play().catch(() => {});
        } else if (was) {
          setPlaying(false);
        }
      }
    },
    [reverseSource, timeStore, durationSec, startReverse, setPlaying],
  );

  const setRate = useCallback(
    (r: number) => {
      const v = clampRate(r);
      rateRef.current = v;
      setRateState(v);
      const a = audioRef.current;
      if (a) {
        a.preservesPitch = true; // 速度を変えても音程は変えない
        a.playbackRate = v;
      }
      if (reverseRef.current && playingRef.current) {
        const pos = revRef.current?.stop();
        if (pos !== undefined) timeStore.set(clamp(pos, 0, durationSec));
        restartReverseSoon();
      }
    },
    [timeStore, durationSec, restartReverseSoon],
  );

  const stepRate = useCallback((delta: number) => setRate(rateRef.current + delta), [setRate]);
  const resetRate = useCallback(() => setRate(1), [setRate]);

  const syncTime = (a: HTMLAudioElement) => {
    if (!reverseRef.current) timeStore.set(clamp(a.currentTime, 0, durationSec));
  };

  const audioProps: Player['audioProps'] = {
    ref: audioRef,
    src: url ?? undefined,
    preload: 'metadata',
    // 逆再生中に <audio> を止めたときのイベントで、再生状態を書き換えない
    onPlay: () => !reverseRef.current && setPlaying(true),
    onPause: () => !reverseRef.current && setPlaying(false),
    onEnded: (e) => {
      if (reverseRef.current) return;
      setPlaying(false);
      syncTime(e.currentTarget);
    },
    onTimeUpdate: (e) => syncTime(e.currentTarget),
    onSeeked: (e) => syncTime(e.currentTarget),
    onLoadedMetadata: (e) => {
      e.currentTarget.preservesPitch = true;
      e.currentTarget.playbackRate = rateRef.current;
    },
    onError: () => {
      unplayableRef.current = true;
      setUnplayable(true);
      setPlaying(false);
    },
  };

  const canReverse = reverseSource !== null && !unplayable;

  return {
    audioProps,
    timeStore,
    playing,
    unplayable,
    rate,
    setRate,
    stepRate,
    resetRate,
    reverse,
    setReverse,
    canReverse,
    reverseError,
    seek,
    skip,
    toggle,
  };
}
