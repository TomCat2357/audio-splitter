import { useEffect, useState } from 'react';
import { formatTime, parseTime } from '../lib/plan';

interface Props {
  value: number;
  label: string;
  testId?: string;
  /** 確定した時刻を渡す。受け付けられなければ false を返す（表示は元に戻る）。 */
  onCommit: (sec: number) => boolean;
}

/** 時刻の入力欄。確定時（Enter / フォーカスを外したとき）に parseTime で解釈し、不正なら元に戻す。 */
export function TimeInput({ value, label, testId, onCommit }: Props) {
  const shown = formatTime(value, { fraction: true });
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);

  const commit = () => {
    if (text === shown) return;
    const sec = parseTime(text);
    if (sec === null || !onCommit(sec)) setText(shown);
  };

  return (
    <input
      className="time-input"
      type="text"
      inputMode="decimal"
      value={text}
      aria-label={label}
      data-testid={testId}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          setText(shown);
        }
      }}
    />
  );
}
