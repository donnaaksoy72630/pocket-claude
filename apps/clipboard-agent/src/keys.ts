/**
 * Key names as Claude writes them for computer use (xdotool style: "ctrl+shift+esc", "Return", "super+r", "alt+F4"),
 * turned into Windows virtual-key codes for the computer host. Codes with EXT are sent as extended keys; CHAR codes
 * carry a character the host looks up in the keyboard layout of the window in front.
 */
export const EXT = 0x100;
export const CHAR = 0x10000;

const char = (c: string) => CHAR | c.charCodeAt(0);

const NAMED: Record<string, number> = {
  ctrl: 0x11, control: 0x11, ctl: 0x11, control_l: 0x11, control_r: 0xa3 | EXT,
  shift: 0x10, shift_l: 0x10, shift_r: 0xa1,
  alt: 0x12, alt_l: 0x12, option: 0x12, alt_r: 0xa5 | EXT, altgr: 0xa5 | EXT,
  super: 0x5b | EXT, super_l: 0x5b | EXT, super_r: 0x5c | EXT, win: 0x5b | EXT, windows: 0x5b | EXT, meta: 0x5b | EXT, cmd: 0x5b | EXT, command: 0x5b | EXT,
  return: 0x0d, enter: 0x0d, kp_enter: 0x0d | EXT, tab: 0x09, escape: 0x1b, esc: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e | EXT, del: 0x2e | EXT, insert: 0x2d | EXT, ins: 0x2d | EXT, home: 0x24 | EXT, end: 0x23 | EXT,
  page_up: 0x21 | EXT, pageup: 0x21 | EXT, prior: 0x21 | EXT, pgup: 0x21 | EXT,
  page_down: 0x22 | EXT, pagedown: 0x22 | EXT, next: 0x22 | EXT, pgdn: 0x22 | EXT,
  up: 0x26 | EXT, down: 0x28 | EXT, left: 0x25 | EXT, right: 0x27 | EXT,
  capslock: 0x14, caps_lock: 0x14, numlock: 0x90 | EXT, num_lock: 0x90 | EXT, scrolllock: 0x91, scroll_lock: 0x91,
  print: 0x2c | EXT, printscreen: 0x2c | EXT, prtsc: 0x2c | EXT, pause: 0x13,
  menu: 0x5d | EXT, apps: 0x5d | EXT, contextmenu: 0x5d | EXT,
  volume_up: 0xaf, xf86audioraisevolume: 0xaf, volume_down: 0xae, xf86audiolowervolume: 0xae, volume_mute: 0xad, mute: 0xad, xf86audiomute: 0xad,
  media_play_pause: 0xb3, xf86audioplay: 0xb3, media_next: 0xb0, xf86audionext: 0xb0, media_prev: 0xb1, xf86audioprev: 0xb1,
  browser_back: 0xa6 | EXT, browser_forward: 0xa7 | EXT, browser_refresh: 0xa8 | EXT,
  kp_add: 0x6b, kp_subtract: 0x6d, kp_multiply: 0x6a, kp_divide: 0x6f | EXT, kp_decimal: 0x6e,
  minus: char('-'), plus: char('+'), equal: char('='), comma: char(','), period: char('.'), slash: char('/'), backslash: char('\\'),
  semicolon: char(';'), colon: char(':'), apostrophe: char("'"), quote: char("'"), quotedbl: char('"'), grave: char('`'), backtick: char('`'),
  bracketleft: char('['), bracketright: char(']'), braceleft: char('{'), braceright: char('}'), less: char('<'), greater: char('>'),
  question: char('?'), exclam: char('!'), at: char('@'), numbersign: char('#'), dollar: char('$'), percent: char('%'),
  asciicircum: char('^'), ampersand: char('&'), asterisk: char('*'), parenleft: char('('), parenright: char(')'),
  underscore: char('_'), bar: char('|'), asciitilde: char('~'),
};

/** One key name to its code; throws with the name for anything unknown. */
export function keyCode(name: string): number {
  if (name.length === 1) {
    const c = name.toLowerCase();
    if (c >= 'a' && c <= 'z') return 0x41 + c.charCodeAt(0) - 97;
    if (c >= '0' && c <= '9') return 0x30 + c.charCodeAt(0) - 48;
    if (c === ' ') return 0x20;
    return char(name);
  }
  const n = name.toLowerCase().replace(/-/g, '_');
  const known = NAMED[n] ?? NAMED[n.replace(/_/g, '')];
  if (known !== undefined) return known;
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(n);
  if (f) return 0x6f + Number(f[1]);
  const kp = /^kp_(\d)$/.exec(n);
  if (kp) return 0x60 + Number(kp[1]);
  throw new Error(`Unknown key "${name}". Use names like ctrl, shift, alt, super, Return, Tab, Escape, BackSpace, Delete, Home, End, Page_Up, Up, F5, or single characters.`);
}

/** "ctrl+c ctrl+v" → two combos; "ctrl++" is ctrl with the plus key. */
export function parseKeys(text: string): number[][] {
  const combos = text.trim().split(/\s+/).filter(Boolean);
  if (!combos.length) throw new Error('No keys given');
  if (combos.length > 20) throw new Error('At most 20 key combinations at a time');
  return combos.map((combo) => combo.split(/\+(?!$)/).map((k) => keyCode(k)));
}
