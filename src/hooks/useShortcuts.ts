import { useEffect, useRef } from 'react';
import { RATE_KEY_STEP } from '../lib/rate';

interface Handlers {
  enabled: boolean;
  onTogglePlay: () => void;
  onSplit: () => void;
  /** 再生速度を delta だけ変える（[ で遅く、] で速く） */
  onRateStep: (delta: number) => void;
  /** 再生速度を 1 倍に戻す（\ または =） */
  onRateReset: () => void;
}

/** 入力欄・選択欄・ボタンなどにフォーカスがあるときは何もしない */
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A', 'AUDIO', 'SUMMARY'].includes(t.tagName);
}

/** Space で再生/一時停止、S で現在位置に分割点を追加、[ ] で再生速度、\ で等速に戻す */
export function useShortcuts(h: Handlers): void {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = ref.current;
      if (!cur.enabled || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        cur.onTogglePlay();
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        cur.onSplit();
      } else if (e.key === '[') {
        e.preventDefault();
        cur.onRateStep(-RATE_KEY_STEP);
      } else if (e.key === ']') {
        e.preventDefault();
        cur.onRateStep(RATE_KEY_STEP);
      } else if (e.key === '\\' || e.key === '=') {
        e.preventDefault();
        cur.onRateReset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
