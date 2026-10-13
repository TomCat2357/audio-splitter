import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  rate: number;
  setRate: (r: number) => void;
  seek: (sec: number) => void;
  skip: (deltaSec: number) => void;
  toggle: () => void;
}

/**
 * 再生まわりをまとめる。全体の長さは audio.duration ではなく durationSec（info.durationSec）を使う。
 * 再生できない形式でも seek は現在位置ストアを更新するので、分割点の指定は続けられる。
 */
export function usePlayer(url: string | null, durationSec: number): Player {
  const audioRef = useRef<HTMLAudioElement>(null);
  const timeStore = useMemo(() => createStore(0), []);
  const [playing, setPlaying] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [rate, setRateState] = useState(1);
  const rateRef = useRef(1);
  const unplayableRef = useRef(false);

  useEffect(() => {
    timeStore.set(0);
    setPlaying(false);
    setUnplayable(false);
    unplayableRef.current = false;
  }, [url, timeStore]);

  // 再生中だけ rAF で currentTime を読み、ストア経由で必要な部品だけ更新する
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a) timeStore.set(clamp(a.currentTime, 0, durationSec));
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, durationSec, timeStore]);

  const seek = useCallback(
    (sec: number) => {
      const s = clamp(sec, 0, Math.max(0, durationSec));
      timeStore.set(s);
      const a = audioRef.current;
      if (a && !unplayableRef.current) {
        try {
          a.currentTime = s;
        } catch {
          // メタデータ未読み込みなどは無視
        }
      }
    },
    [durationSec, timeStore],
  );

  const skip = useCallback(
    (delta: number) => seek(stepTime(timeStore.get(), delta, durationSec)),
    [seek, timeStore, durationSec],
  );

  const toggle = useCallback(() => {
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
  }, [seek, timeStore, durationSec]);

  const setRate = useCallback((r: number) => {
    rateRef.current = r;
    setRateState(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
  }, []);

  const syncTime = (a: HTMLAudioElement) => timeStore.set(clamp(a.currentTime, 0, durationSec));

  const audioProps: Player['audioProps'] = {
    ref: audioRef,
    src: url ?? undefined,
    preload: 'metadata',
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: (e) => {
      setPlaying(false);
      syncTime(e.currentTarget);
    },
    onTimeUpdate: (e) => syncTime(e.currentTarget),
    onSeeked: (e) => syncTime(e.currentTarget),
    onLoadedMetadata: (e) => {
      e.currentTarget.playbackRate = rateRef.current;
    },
    onError: () => {
      unplayableRef.current = true;
      setUnplayable(true);
      setPlaying(false);
    },
  };

  return { audioProps, timeStore, playing, unplayable, rate, setRate, seek, skip, toggle };
}
