import { describe, expect, it } from 'vitest';
import { CHAR, EXT, keyCode, parseKeys } from '../src/keys.js';

describe('key names', () => {
  it('map xdotool-style names to Windows virtual keys', () => {
    expect(parseKeys('ctrl+shift+esc')).toEqual([[0x11, 0x10, 0x1b]]);
    expect(parseKeys('Return')).toEqual([[0x0d]]);
    expect(parseKeys('alt+F4')).toEqual([[0x12, 0x73]]);
    expect(parseKeys('super+r')).toEqual([[0x5b | EXT, 0x52]]);
    expect(parseKeys('Page_Down BackSpace KP_Enter')).toEqual([[0x22 | EXT], [0x08], [0x0d | EXT]]);
    expect(parseKeys('ctrl+C')).toEqual([[0x11, 0x43]]);
    expect(parseKeys('F24')).toEqual([[0x87]]);
  });

  it('read several combinations and the plus key itself', () => {
    expect(parseKeys('ctrl+a ctrl+c')).toEqual([[0x11, 0x41], [0x11, 0x43]]);
    expect(parseKeys('ctrl++')).toEqual([[0x11, CHAR | 0x2b]]);
    expect(parseKeys('+')).toEqual([[CHAR | 0x2b]]);
  });

  it('leave punctuation and other characters to the keyboard layout', () => {
    expect(keyCode('slash')).toBe(CHAR | 0x2f);
    expect(keyCode(';')).toBe(CHAR | 0x3b);
    expect(keyCode('ё')).toBe(CHAR | 'ё'.charCodeAt(0));
    expect(keyCode('7')).toBe(0x37);
  });

  it('refuse unknown names with a hint and empty or huge input', () => {
    expect(() => parseKeys('ctrl+hyper')).toThrow(/Unknown key "hyper"/);
    expect(() => parseKeys('   ')).toThrow(/No keys/);
    expect(() => parseKeys(Array(21).fill('a').join(' '))).toThrow(/At most 20/);
  });
});
