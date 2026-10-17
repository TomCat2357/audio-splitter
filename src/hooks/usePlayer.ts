import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clampPitch, pitchRatioOf } from '../lib/pitch';
import { clampRate } from '../lib/rate';
import { createStore, type Store } from '../lib/store';
import { clamp, stepTime } from '../lib/timeline';
import { WebAudioPlayer, type PlayParams } from '../lib/webplayer';

export interface Player {
  /** <audio> に展開して使う props */
  audioProps: React.AudioHTMLAttributes<HTMLAudioElement> & { ref: React.RefObject<HTMLAudioElement | null> };
  /** 現在位置（秒）。再生中は rAF で更新される。購読した部品だけが再レンダリングされる。 */
  timeStore: Store<number>;
  playing: boolean;
  /** ブラウザがこの形式を再生できない */
  unplayable: boolean;
  /** 再生速度の倍率（0.25〜4）。順再生・逆再生どちらにも効く */
  rate: number;
  setRate: (r: number) => void;
  /** 現在の速度に delta を足す（範囲内に収める） */
  stepRate: (delta: number) => void;
  resetRate: () => void;
  /** 音程（半音、−12〜+12）。速度とは独立に効く */
  pitch: number;
  setPitch: (semitones: number) => void;
  /** 現在の音程に delta（半音）を足す（範囲内に収める） */
  stepPitch: (delta: number) => void;
  /** 速度を変えても音程を保つか。false ならテープのように速度に比例して音程も変わる（そこへ pitch が重なる） */
  keepPitch: boolean;
  setKeepPitch: (on: boolean) => void;
  /** 逆再生（方向のトグル。速度は常に正の値のまま） */
  reverse: boolean;
  setReverse: (on: boolean) => void;
  /** 逆再生・音程の変更を使えるか（デコードできて、順再生もできる） */
  canProcess: boolean;
  /** Web Audio での再生（逆再生・音程の変更）に失敗したときのメッセージ */
  playError: string | null;
  seek: (sec: number) => void;
  skip: (deltaSec: number) => void;
  toggle: () => void;
}

/** 逆再生・音程の変更で使う入力。デコードできないファイルでは null */
export interface ReverseSource {
  file: File;
  sampleRate: number;
}

/** Web Audio で再生中にシークや速度変更が連続したとき、鳴らし直すまで待つ時間（ミリ秒） */
const RESTART_MS = 80;

/**
 * 再生まわりをまとめる。全体の長さは audio.duration ではなく durationSec（info.durationSec）を使う。
 * 再生できない形式でも seek は現在位置ストアを更新するので、分割点の指定は続けられる。
 *
 * 鳴らし方は 2 通り。どちらでも再生/停止・シーク・±秒・速度変更は同じ関数で扱い、位置は timeStore に集約する。
 * - <audio>: 順再生で音程（半音）が 0 のとき。「音程を保つ」は preservesPitch でそのまま実現できる
 * - Web Audio（lib/webplayer.ts）: 逆再生、または音程（半音）を変えているとき
 * 鳴らし方の切り替えは現在位置から続ける。
 */
export function usePlayer(url: string | null, durationSec: number, reverseSource: ReverseSource | null = null): Player {
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeStore = useMemo(() => createStore(0), []);
  const [playing, setPlayingState] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [rate, setRateState] = useState(1);
  const [pitch, setPitchState] = useState(0);
  const [keepPitch, setKeepPitchState] = useState(true);
  const [reverse, setReverseState] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const pitchRef = useRef(0);
  const keepPitchRef = useRef(true);
  const reverseRef = useRef(false);
  /** いま Web Audio で鳴らす設定か（reverse || pitch !== 0） */
  const webRef = useRef(false);
  const unplayableRef = useRef(false);
  const webPlayer = useRef<WebAudioPlayer | null>(null);
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

  const params = (): PlayParams => ({
    speed: rateRef.current,
    pitchRatio: pitchRatioOf(pitchRef.current, rateRef.current, keepPitchRef.current),
    reverse: reverseRef.current,
  });

  /** <audio> に速度と「音程を保つ」を反映する */
  const applyAudioRate = (a: HTMLAudioElement | null) => {
    if (!a) return;
    a.preservesPitch = keepPitchRef.current;
    a.playbackRate = rateRef.current;
  };

  useEffect(() => {
    timeStore.set(0);
    setPlaying(false);
    setUnplayable(false);
    unplayableRef.current = false;
    reverseRef.current = false;
    setReverseState(false);
    webRef.current = pitchRef.current !== 0;
    setPlayError(null);
  }, [url, timeStore, setPlaying]);

  // ファイルが変わったら Web Audio の部品を捨てる（AudioContext と mediabunny の Input を解放する）
  useEffect(() => {
    // デコードできないファイルでは音程を変えられないので、元の音程に戻す
    if (!reverseSource && pitchRef.current !== 0) {
      pitchRef.current = 0;
      setPitchState(0);
      webRef.current = reverseRef.current;
    }
    return () => {
      clearRestart();
      webPlayer.current?.dispose();
      webPlayer.current = null;
    };
  }, [reverseSource]);

  // 再生中だけ rAF で位置を読み、ストア経由で必要な部品だけ更新する
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      if (webRef.current) {
        const r = webPlayer.current;
        // 鳴らし直しの待ち中（isActive が false）は、シークした位置をそのまま見せる
        if (r?.isActive) {
          if (r.finished) {
            r.stop();
            // 逆再生は先頭、順再生は末尾で止まる
            timeStore.set(reverseRef.current ? 0 : durationSec);
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

  // ---- Web Audio の下請け ----
  const failWeb = useCallback(
    (message: string) => {
      clearRestart();
      // <audio> で鳴らせる設定（順再生・元の音程）に戻す
      reverseRef.current = false;
      setReverseState(false);
      pitchRef.current = 0;
      setPitchState(0);
      webRef.current = false;
      setPlayError(message);
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

  const startWeb = useCallback(
    (from: number) => {
      if (!reverseSource) return;
      webPlayer.current ??= new WebAudioPlayer(reverseSource.file, reverseSource.sampleRate, durationSec, {
        onError: failWeb,
      });
      void webPlayer.current.start(from, params());
    },
    [reverseSource, durationSec, failWeb],
  );

  /** Web Audio で再生中に位置や設定が変わったとき。いったん止め、連続する変更が落ち着いてから鳴らし直す */
  const restartWebSoon = useCallback(() => {
    clearRestart();
    restartTimer.current = setTimeout(() => {
      restartTimer.current = null;
      if (webRef.current && playingRef.current) startWeb(timeStore.get());
    }, RESTART_MS);
  }, [startWeb, timeStore]);

  /**
   * 速度・音程・方向を変える。mutate で ref を書き換えたあと、鳴らし方（<audio> / Web Audio）が変わるなら
   * 現在位置を引き継いで切り替え、Web Audio のままなら新しい設定で鳴らし直す。
   */
  const reconfigure = useCallback(
    (mutate: () => void) => {
      const wasWeb = webRef.current;
      const was = playingRef.current;
      const a = audioRef.current;
      // 切り替える前の位置
      let pos = timeStore.get();
      if (wasWeb) {
        const r = webPlayer.current;
        if (was && r?.isActive) pos = clamp(r.stop(), 0, durationSec);
      } else if (a && !unplayableRef.current) {
        pos = clamp(a.currentTime, 0, durationSec);
      }

      mutate();
      const nowWeb = reverseRef.current || pitchRef.current !== 0;
      webRef.current = nowWeb;
      applyAudioRate(a);
      if (!was) return;

      timeStore.set(pos);
      if (nowWeb) {
        if (!wasWeb) {
          // <audio> → Web Audio
          a?.pause();
          clearRestart();
          startWeb(pos);
        } else {
          restartWebSoon();
        }
      } else if (wasWeb) {
        // Web Audio → <audio>
        clearRestart();
        if (a && !unplayableRef.current) {
          try {
            a.currentTime = pos;
          } catch {
            // メタデータ未読み込みなどは無視
          }
          a.play().catch(() => {});
        } else {
          setPlaying(false);
        }
      }
    },
    [timeStore, durationSec, startWeb, restartWebSoon, setPlaying],
  );

  const seek = useCallback(
    (sec: number) => {
      const s = clamp(sec, 0, Math.max(0, durationSec));
      timeStore.set(s);
      // Web Audio で鳴らしている間も <audio> の位置は合わせておく（<audio> に戻すとき、その位置から続けられる）
      const a = audioRef.current;
      if (a && !unplayableRef.current) {
        try {
          a.currentTime = s;
        } catch {
          // メタデータ未読み込みなどは無視
        }
      }
      if (webRef.current && playingRef.current) {
        webPlayer.current?.stop();
        restartWebSoon();
      }
    },
    [durationSec, timeStore, restartWebSoon],
  );

  const skip = useCallback(
    (delta: number) => seek(stepTime(timeStore.get(), delta, durationSec)),
    [seek, timeStore, durationSec],
  );

  const toggle = useCallback(() => {
    if (webRef.current) {
      if (playingRef.current) {
        clearRestart();
        // 鳴らし直しの待ち中（isActive が false）に止めたときは、シークした位置のまま
        const r = webPlayer.current;
        if (r?.isActive) timeStore.set(clamp(r.stop(), 0, durationSec));
        setPlaying(false);
      } else {
        // 端では進めないので、反対の端から始める
        let from = timeStore.get();
        if (reverseRef.current && from <= 0.05) from = durationSec;
        else if (!reverseRef.current && from >= durationSec - 0.05) from = 0;
        timeStore.set(from);
        setPlaying(true);
        startWeb(from);
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
  }, [seek, timeStore, durationSec, setPlaying, startWeb]);

  const setReverse = useCallback(
    (on: boolean) => {
      if (on === reverseRef.current) return;
      if (on && (!reverseSource || unplayableRef.current)) return;
      if (on) setPlayError(null);
      reconfigure(() => {
        reverseRef.current = on;
        setReverseState(on);
      });
    },
    [reverseSource, reconfigure],
  );

  const setPitch = useCallback(
    (semitones: number) => {
      const v = clampPitch(semitones);
      if (v === pitchRef.current) return;
      if (v !== 0 && (!reverseSource || unplayableRef.current)) return;
      if (v !== 0) setPlayError(null);
      reconfigure(() => {
        pitchRef.current = v;
        setPitchState(v);
      });
    },
    [reverseSource, reconfigure],
  );

  const stepPitch = useCallback((delta: number) => setPitch(pitchRef.current + delta), [setPitch]);

  const setKeepPitch = useCallback(
    (on: boolean) => {
      if (on === keepPitchRef.current) return;
      reconfigure(() => {
        keepPitchRef.current = on;
        setKeepPitchState(on);
      });
    },
    [reconfigure],
  );

  const setRate = useCallback(
    (r: number) => {
      const v = clampRate(r);
      if (v === rateRef.current) return;
      reconfigure(() => {
        rateRef.current = v;
        setRateState(v);
      });
    },
    [reconfigure],
  );

  const stepRate = useCallback((delta: number) => setRate(rateRef.current + delta), [setRate]);
  const resetRate = useCallback(() => setRate(1), [setRate]);

  const syncTime = (a: HTMLAudioElement) => {
    if (!webRef.current) timeStore.set(clamp(a.currentTime, 0, durationSec));
  };

  const audioProps: Player['audioProps'] = {
    ref: audioRef,
    src: url ?? undefined,
    preload: 'metadata',
    // Web Audio で鳴らしている間に <audio> を止めたときのイベントで、再生状態を書き換えない
    onPlay: () => !webRef.current && setPlaying(true),
    onPause: () => !webRef.current && setPlaying(false),
    onEnded: (e) => {
      if (webRef.current) return;
      setPlaying(false);
      syncTime(e.currentTarget);
    },
    onTimeUpdate: (e) => syncTime(e.currentTarget),
    onSeeked: (e) => syncTime(e.currentTarget),
    onLoadedMetadata: (e) => applyAudioRate(e.currentTarget),
    onError: () => {
      unplayableRef.current = true;
      setUnplayable(true);
      setPlaying(false);
    },
  };

  const canProcess = reverseSource !== null && !unplayable;

  return {
    audioProps,
    timeStore,
    playing,
    unplayable,
    rate,
    setRate,
    stepRate,
    resetRate,
    pitch,
    setPitch,
    stepPitch,
    keepPitch,
    setKeepPitch,
    reverse,
    setReverse,
    canProcess,
    playError,
    seek,
    skip,
    toggle,
  };
}
