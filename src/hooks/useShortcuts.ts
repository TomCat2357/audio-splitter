import { useEffect, useRef } from 'react';

interface Handlers {
  enabled: boolean;
  onTogglePlay: () => void;
  onSplit: () => void;
}

/** 入力欄・選択欄・ボタンなどにフォーカスがあるときは何もしない */
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'A', 'AUDIO', 'SUMMARY'].includes(t.tagName);
}

/** Space で再生/一時停止、S で現在位置に分割点を追加 */
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
