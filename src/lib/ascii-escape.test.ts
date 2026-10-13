import { describe, expect, it } from 'vitest';
import { escapeNonAscii } from '../../scripts/vite-ascii-escape.mjs';

describe('escapeNonAscii', () => {
  it('output is pure ASCII and evaluates to the same value (string / template / regex / surrogate pairs)', () => {
    const src = 'return ["あ🔄", `日本語${1 + 1}🎉`, /[ぁ-ん]+/.test("ひら"), "café"]';
    const out = escapeNonAscii(src);
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
    expect(new Function(out)()).toEqual(new Function(src)());
  });
  it('leaves ASCII untouched', () => {
    expect(escapeNonAscii('const a = "x\\n";')).toBe('const a = "x\\n";');
  });
});
