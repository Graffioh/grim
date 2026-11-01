// Vim mode for the editor (the account menu's "Vim mode", per browser; off by default). VimCore is the key machine:
// pure, on the Markdown text and UTF-16 offsets through a VimHost (input.ts gives it the engine: edits go through
// replace_range, undo/redo are the engine's, so collaboration and history stay the editor's own). Insert mode leaves
// keys to the editor (its typing rules: lists, pairs, IME); only Escape (or Ctrl-[) is Vim's there.
//
// Normal: counts; h j k l, w W b B e E, 0 ^ $, gg G, f F t T ; ,, { }, %, - +, Enter, gj gk, n N * #, / ?, Ctrl-D/U;
// operators d c y > < with any motion, doubled (dd) or a text object (iw aw iW aW, i" a" i' a' i` a`, i( a( ib,
// i[ a[, i{ a{ iB, i< a<, ip ap); x X s S D C Y p P J r ~ i a I A o O u Ctrl-R . zz zt zb, :<line>. Visual v and
// V: motions, text objects, o, d x y c s > < ~ u U J p. One unnamed register (a yank also goes to the clipboard).

/** localStorage key of the setting. */
export const VIM_KEY = "grimoire.vim.v1";
/** Dispatched on window when the setting changes (every editor follows). */
export const VIM_EVENT = "grimoire:vim";

export function vimEnabled(): boolean {
  try {
    return localStorage.getItem(VIM_KEY) === "1";
  } catch {
    return false;
  }
}

export function setVimEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(VIM_KEY, "1");
    else localStorage.removeItem(VIM_KEY);
  } catch {}
  dispatchEvent(new CustomEvent(VIM_EVENT, { detail: on }));
}

export type VimMode = "normal" | "insert" | "visual" | "vline";

export interface VimHost {
  text(): string;
  sel(): { anchor: number; head: number };
  /** Put the selection (and bring the caret into view). */
  select(anchor: number, head: number): void;
  /** Replace [from, to) as one edit (one undo step), without typing rules. */
  replace(from: number, to: number, text: string): void;
  undo(): void;
  redo(): void;
  /** The editor's own Enter at the caret (continues a list): `o`. */
  enter(): void;
  readOnly(): boolean;
  /**
   * One line up or down as the note shows it (a wrapped paragraph is several), at x `goalX` (null: the caret's own x),
   * or null at the edge: j, k (without a count), gj, gk. Without it they move by the text's lines.
   */
  displayLine?(pos: number, dir: 1 | -1, goalX: number | null): { pos: number; x: number } | null;
  /** Lines in half a screen (Ctrl-D, Ctrl-U). */
  halfPage?(): number;
  scroll?(where: "center" | "top" | "bottom"): void;
  /** Ask for a search or command line; `done(null)` when cancelled. */
  prompt?(kind: "/" | "?" | ":", done: (s: string | null) => void): void;
  yanked?(text: string): void;
  /**
   * Where the text of the line holding `pos` starts, after its list or quote marker ("1. ", "- ", "> "): the editor
   * keeps the caret out of a marker's inside, so Vim steps over it as one piece. Absent: the line start.
   */
  textStart?(pos: number): number;
  /** Something to tell the user ("Pattern not found: x"). */
  message?(text: string): void;
}

type Range = { from: number; to: number; linewise?: boolean };
type Motion = { pos: number; linewise?: boolean; inclusive?: boolean };

/** Thrown while parsing when the keys so far are a prefix of a command. */
const MORE = Symbol("more");
/** Thrown when the keys can't be a command (or can't be done here): they are dropped. */
const BAD = Symbol("bad");

const OPS = new Set(["d", "c", "y", ">", "<"]);
const PAIRS: Record<string, [string, string]> = {
  "(": ["(", ")"], ")": ["(", ")"], b: ["(", ")"],
  "[": ["[", "]"], "]": ["[", "]"],
  "{": ["{", "}"], "}": ["{", "}"], B: ["{", "}"],
  "<": ["<", ">"], ">": ["<", ">"],
};

/** 0 blank (newlines too), 1 word, 2 punctuation; `big`: 1 for anything not blank (WORDs). */
function cls(c: string | undefined, big: boolean): number {
  if (c === undefined || /\s/.test(c)) return 0;
  if (big) return 1;
  return /[\p{L}\p{N}_]/u.test(c) ? 1 : 2;
}

export class VimCore {
  mode: VimMode = "normal";
  /** Keys typed for a command not complete yet (shown beside the mode). */
  private buf: string[] = [];
  /** Visual mode's fixed end and moving end (character positions). */
  private vAnchor = 0;
  private vHead = 0;
  /** j/k's column (Infinity after $). */
  private goal: number | null = null;
  /** j/k's x on screen, moving by shown lines (kept across short lines, like the column). */
  private goalX: number | null = null;
  private register: { text: string; linewise: boolean } = { text: "", linewise: false };
  private lastFind: { k: string; c: string } | null = null;
  private lastSearch: { term: string; back: boolean; word: boolean } | null = null;
  /** For `.`: the keys of the last change, and what was typed in the insert mode it started. */
  private lastChange: { keys: string[]; insert: string | null } | null = null;
  /** The change being recorded is in insert mode now: the text and caret when insert mode began. */
  private recording: { keys: string[]; text: string } | null = null;
  private replaying = false;
  /** The command being run changes the text (recorded for `.`). */
  private changed = false;

  constructor(private readonly h: VimHost) {}

  /** What to show beside the mode: the pending keys. */
  get pending(): string {
    return this.buf.join("");
  }

  /** Back to normal mode with nothing pending (Vim turned on, or the note changed). */
  reset(): void {
    this.mode = "normal";
    this.buf = [];
    this.recording = null;
    const s = this.h.sel();
    if (s.anchor !== s.head) this.select(s.head);
    else this.clampCaret();
  }

  /** A key (a character, or <Esc>, <CR>, <BS>, <C-r>, <C-d>, <C-u>): true if Vim took it. */
  key(k: string): boolean {
    if (this.mode === "insert") {
      if (k !== "<Esc>") return false;
      this.leaveInsert();
      return true;
    }
    // a selection made with the mouse (or the editor's own keys) becomes Visual
    if (this.mode === "normal" && this.buf.length === 0) {
      const s = this.h.sel();
      if (s.anchor !== s.head) {
        this.mode = "visual";
        this.vAnchor = s.anchor;
        this.vHead = s.head > s.anchor ? s.head - 1 : s.head;
      }
    }
    this.buf.push(k);
    const keys = this.buf.slice();
    const from = this.mode;
    const r = this.run(keys);
    if (r === "more") return true;
    this.buf = [];
    // `.` repeats changes made in normal mode (a Visual change would need its region again)
    if (r === "done" && this.changed && !this.replaying && from === "normal") {
      if ((this.mode as VimMode) === "insert") this.recording = { keys, text: this.h.text() };
      else this.lastChange = { keys, insert: null };
    }
    return true;
  }

  /** The search or command line came back. */
  searchFor(term: string, back: boolean): void {
    if (!term) {
      if (!this.lastSearch) return;
      term = this.lastSearch.term;
    }
    this.lastSearch = { term, back, word: false };
    this.jumpSearch(1, false);
  }

  ex(cmd: string): void {
    const c = cmd.trim();
    if (/^\d+$/.test(c)) {
      const t = this.h.text();
      this.select(this.firstNonBlank(this.lineStartOfLine(t, parseInt(c, 10) - 1)));
      return;
    }
    if (/^(w|wa|wq|x|q|q!|noh|nohlsearch)$/.test(c)) return; // notes save themselves; nothing to quit
    if (c) this.h.message?.(`Not an editor command: ${c}`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Parsing and running

  private run(keys: string[]): "more" | "done" | "bad" {
    let i = 0;
    const next = (): string => {
      if (i >= keys.length) throw MORE;
      return keys[i++]!;
    };
    const readCount = (): number => {
      let n = 0;
      while (i < keys.length && /^[0-9]$/.test(keys[i]!) && (n > 0 || keys[i] !== "0")) n = n * 10 + Number(keys[i++]);
      if (i >= keys.length && n > 0) throw MORE;
      return n;
    };
    this.changed = false;
    try {
      if (this.mode === "visual" || this.mode === "vline") this.visual(next, readCount);
      else this.normal(next, readCount);
      return "done";
    } catch (e) {
      if (e === MORE) return "more";
      if (e === BAD) {
        if (this.mode === "normal") this.clampCaret();
        return "bad";
      }
      throw e;
    }
  }

  private normal(next: () => string, readCount: () => number): void {
    const c1 = readCount();
    const k = next();
    const t = this.h.text();
    const cur = this.caret();
    const n = Math.max(1, c1);

    if (OPS.has(k)) {
      const c2 = readCount();
      const count = Math.max(1, c1) * Math.max(1, c2);
      const m = next();
      let r: Range;
      if (m === k) {
        const last = this.lineDown(t, cur, count - 1, true);
        r = { from: cur, to: last, linewise: true };
      } else if (m === "i" || m === "a") {
        r = this.textObject(t, cur, m === "a", next());
      } else {
        const mv = this.motion(t, cur, m, count, c1 > 0 || c2 > 0, next, k);
        if (!mv) throw BAD;
        r = mv.linewise ? { from: cur, to: mv.pos, linewise: true } : this.charRange(cur, mv.pos, !!mv.inclusive, t);
      }
      this.operate(k, r, cur);
      return;
    }

    const mv = this.motion(t, cur, k, n, c1 > 0, next, null);
    if (mv) {
      this.land(mv.pos, cur);
      return;
    }

    const ls = this.lineStart(t, cur);
    const le = this.lineEnd(t, cur);
    switch (k) {
      case "<Esc>":
        return;
      case "i":
        return this.insertAt(cur);
      case "a":
        return this.insertAt(this.overMarker(Math.min(cur + 1, le), cur));
      case "I":
        return this.insertAt(this.firstNonBlank(ls));
      case "A":
        return this.insertAt(le);
      case "o":
        this.writable();
        this.select(le);
        this.h.enter();
        this.changed = true;
        this.mode = "insert";
        return;
      case "O": {
        this.writable();
        const indent = /^[ \t]*/.exec(t.slice(ls, le))![0];
        this.h.replace(ls, ls, indent + "\n");
        this.select(ls + indent.length);
        this.changed = true;
        this.mode = "insert";
        return;
      }
      case "x":
        if (cur >= le) throw BAD;
        return this.operate("d", { from: cur, to: Math.min(cur + n, le) }, cur);
      case "X":
        if (cur <= ls) throw BAD;
        return this.operate("d", { from: Math.max(ls, cur - n), to: cur }, cur);
      case "s":
        return this.operate("c", { from: cur, to: Math.min(cur + n, le) }, cur);
      case "S":
        return this.operate("c", { from: cur, to: this.lineDown(t, cur, n - 1, true), linewise: true }, cur);
      case "D":
      case "C":
        return this.operate(k === "D" ? "d" : "c", { from: cur, to: this.lineEnd(t, this.lineDown(t, cur, n - 1, true)) }, cur);
      case "Y":
        return this.operate("y", { from: cur, to: this.lineDown(t, cur, n - 1, true), linewise: true }, cur);
      case "p":
      case "P":
        return this.put(k === "P", n);
      case "J":
        return this.join(cur, Math.max(2, n));
      case "r": {
        const c = next();
        if ([...c].length !== 1 && c !== "<CR>") throw BAD;
        if (cur + n > le) throw BAD;
        this.writable();
        const rep = c === "<CR>" ? "\n" : c.repeat(n);
        this.h.replace(cur, cur + n, rep);
        this.changed = true;
        this.select(c === "<CR>" ? cur + 1 : cur + n - 1);
        return;
      }
      case "~": {
        if (cur >= le) throw BAD;
        this.writable();
        const to = Math.min(cur + n, le);
        this.h.replace(cur, to, swapCase(t.slice(cur, to)));
        this.changed = true;
        this.select(this.clampNormal(this.h.text(), to));
        return;
      }
      case "u":
        for (let j = 0; j < n; j++) this.h.undo();
        return this.clampCaret();
      case "<C-r>":
        for (let j = 0; j < n; j++) this.h.redo();
        return this.clampCaret();
      case ".":
        return this.repeat(n);
      case "v":
      case "V":
        this.mode = k === "v" ? "visual" : "vline";
        this.vAnchor = this.vHead = cur;
        this.showVisual();
        return;
      case "/":
      case "?":
        if (!this.h.prompt) throw BAD;
        this.h.prompt(k, (s) => s !== null && this.searchFor(s, k === "?"));
        return;
      case ":":
        if (!this.h.prompt) throw BAD;
        this.h.prompt(":", (s) => s !== null && this.ex(s));
        return;
      case "z": {
        const z = next();
        const where = z === "z" || z === "." ? "center" : z === "t" || z === "<CR>" ? "top" : z === "b" || z === "-" ? "bottom" : null;
        if (!where) throw BAD;
        this.h.scroll?.(where);
        return;
      }
      default:
        throw BAD;
    }
  }

  private visual(next: () => string, readCount: () => number): void {
    const c1 = readCount();
    const k = next();
    const t = this.h.text();
    const n = Math.max(1, c1);
    const line = this.mode === "vline";

    if (k === "<Esc>" || (k === "v" && !line) || (k === "V" && line)) return this.leaveVisual(this.vHead);
    if (k === "v" || k === "V") {
      this.mode = k === "v" ? "visual" : "vline";
      return this.showVisual();
    }
    if (k === "o") {
      [this.vAnchor, this.vHead] = [this.vHead, this.vAnchor];
      return this.showVisual();
    }
    if (k === "i" || k === "a") {
      const r = this.textObject(t, this.vHead, k === "a", next());
      if (r.linewise) this.mode = "vline";
      this.vAnchor = r.from;
      this.vHead = Math.max(r.from, r.to - 1);
      return this.showVisual();
    }
    const mv = this.motion(t, this.vHead, k, n, c1 > 0, next, null);
    if (mv) {
      this.vHead = Math.min(this.overMarker(mv.pos, this.vHead), Math.max(0, t.length));
      return this.showVisual();
    }

    const a = Math.min(this.vAnchor, this.vHead);
    const b = Math.max(this.vAnchor, this.vHead);
    const r: Range = line ? { from: a, to: b, linewise: true } : { from: a, to: Math.min(b + 1, t.length) };
    switch (k) {
      case "d":
      case "x":
      case "y":
      case "c":
      case "s":
      case ">":
      case "<":
        this.mode = "normal";
        return this.operate(k === "x" ? "d" : k === "s" ? "c" : k, r, a);
      case "D":
      case "X":
      case "Y":
      case "C":
      case "S":
      case "R":
        this.mode = "normal";
        return this.operate(k === "D" || k === "X" ? "d" : k === "Y" ? "y" : "c", { from: a, to: b, linewise: true }, a);
      case "~":
      case "u":
      case "U": {
        this.writable();
        const [from, to] = this.span(t, r);
        const s = t.slice(from, to);
        this.h.replace(from, to, k === "~" ? swapCase(s) : k === "u" ? s.toLowerCase() : s.toUpperCase());
        return this.leaveVisual(from);
      }
      case "J": {
        this.mode = "normal";
        const lines = t.slice(this.lineStart(t, a), this.lineEnd(t, b)).split("\n").length;
        return this.join(this.lineStart(t, a), Math.max(2, lines));
      }
      case "p":
      case "P": {
        this.writable();
        const reg = this.register;
        const [from, to] = this.span(t, r);
        this.mode = "normal";
        if (line) this.h.replace(from, to, reg.linewise ? reg.text.replace(/\n$/, "") : reg.text);
        else this.h.replace(from, to, reg.linewise ? "\n" + reg.text : reg.text);
        this.select(this.clampNormal(this.h.text(), from));
        return;
      }
      default:
        throw BAD;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Motions

  /** A motion from `cur`, or null when `k` isn't one. `op`: an operator is waiting for it. */
  private motion(t: string, cur: number, k: string, n: number, hasCount: boolean, next: () => string, op: string | null): Motion | null {
    const ls = this.lineStart(t, cur);
    const le = this.lineEnd(t, cur);
    const opMode = op !== null;
    switch (k) {
      case "h":
      case "<BS>":
        this.goal = this.goalX = null;
        if (cur <= ls && opMode) throw BAD;
        return { pos: Math.max(ls, cur - n) };
      case "l":
      case " ":
        this.goal = this.goalX = null;
        if (opMode) return { pos: Math.min(cur + n, le) };
        return { pos: Math.min(cur + n, Math.max(ls, le - 1)) };
      case "j":
      case "k": {
        const dir = k === "j" ? 1 : -1;
        // a plain j/k moves one line as shown (a long paragraph wraps); with a count or an operator, the text's lines
        if (!opMode && !hasCount && this.h.displayLine) {
          const r = this.h.displayLine(cur, dir, this.goalX);
          if (!r) throw BAD;
          this.goal = null;
          this.goalX = r.x;
          return { pos: r.pos };
        }
        this.goalX = null;
        const target = this.lineDown(t, cur, dir * n, false);
        if (target === null) throw BAD;
        return { pos: this.atGoal(t, cur, target), linewise: true };
      }
      case "<C-d>":
      case "<C-u>": {
        const dir = k === "<C-d>" ? 1 : -1;
        const target = this.lineDown(t, cur, dir * (this.h.halfPage?.() ?? 15) * n, true);
        return { pos: this.firstNonBlank(target), linewise: true };
      }
      case "+":
      case "<CR>":
      case "-": {
        const target = this.lineDown(t, cur, (k === "-" ? -1 : 1) * n, false);
        if (target === null) throw BAD;
        this.goal = this.goalX = null;
        return { pos: this.firstNonBlank(target), linewise: true };
      }
      case "w":
      case "W": {
        this.goal = this.goalX = null;
        const big = k === "W";
        // cw on a word changes to its end, like ce
        if (op === "c" && cls(t[cur], big) !== 0) {
          let p = cur;
          for (let j = 0; j < n; j++) p = j === 0 && cls(t[p + 1], big) !== cls(t[p], big) ? p : this.wordEnd(t, p, big);
          return { pos: p, inclusive: true };
        }
        let p = cur;
        for (let j = 0; j < n; j++) p = this.wordStart(t, p, big);
        // an operator's last word stops at the end of its line
        if (opMode && this.lineStart(t, p) > ls && p > cur) {
          const endOfLast = this.lineEnd(t, this.lineStart(t, p) - 1);
          if (endOfLast > cur && t.slice(this.lineStart(t, endOfLast), endOfLast).trim()) p = endOfLast;
        }
        return { pos: p };
      }
      case "b":
      case "B": {
        this.goal = this.goalX = null;
        let p = cur;
        for (let j = 0; j < n; j++) p = this.wordBack(t, p, k === "B");
        return { pos: p };
      }
      case "e":
      case "E": {
        this.goal = this.goalX = null;
        let p = cur;
        for (let j = 0; j < n; j++) p = this.wordEnd(t, p, k === "E");
        return { pos: p, inclusive: true };
      }
      case "0":
        this.goal = this.goalX = null;
        return { pos: ls };
      case "^":
        this.goal = this.goalX = null;
        return { pos: this.firstNonBlank(ls) };
      case "$": {
        const end = this.lineEnd(t, this.lineDown(t, cur, n - 1, true));
        this.goal = Infinity;
        this.goalX = null;
        if (opMode) return { pos: end };
        return { pos: Math.max(this.lineStart(t, end), end - 1) };
      }
      case "g": {
        const g = next();
        if (g === "g") {
          this.goal = this.goalX = null;
          return { pos: this.firstNonBlank(hasCount ? this.lineStartOfLine(t, n - 1) : 0), linewise: true };
        }
        if (g === "j" || g === "k") {
          const dir = g === "j" ? 1 : -1;
          let p = cur;
          for (let j = 0; j < n; j++) {
            if (this.h.displayLine) {
              const r = this.h.displayLine(p, dir, this.goalX);
              if (!r) break;
              p = r.pos;
              this.goalX = r.x;
            } else {
              const q = this.lineDown(t, p, dir, false);
              if (q === null) break;
              p = q;
            }
          }
          if (p === cur) throw BAD;
          return { pos: p };
        }
        if (g === "_") return { pos: Math.max(ls, this.lastNonBlank(t, this.lineDown(t, cur, n - 1, true))), inclusive: true };
        throw BAD;
      }
      case "G":
        this.goal = this.goalX = null;
        return { pos: this.firstNonBlank(hasCount ? this.lineStartOfLine(t, n - 1) : this.lineStart(t, t.length)), linewise: true };
      case "f":
      case "F":
      case "t":
      case "T": {
        const c = next();
        if ([...c].length !== 1) throw BAD;
        this.lastFind = { k, c };
        return this.find(t, cur, k, c, n);
      }
      case ";":
      case ",": {
        if (!this.lastFind) throw BAD;
        let { k: fk } = this.lastFind;
        if (k === ",") fk = { f: "F", F: "f", t: "T", T: "t" }[fk]!;
        return this.find(t, cur, fk, this.lastFind.c, n, true);
      }
      case "}":
      case "{": {
        this.goal = this.goalX = null;
        let p = cur;
        for (let j = 0; j < n; j++) p = k === "}" ? this.paraFwd(t, p) : this.paraBack(t, p);
        return { pos: p };
      }
      case "%": {
        const p = this.matchBracket(t, cur);
        if (p === null) throw BAD;
        this.goal = this.goalX = null;
        return { pos: p, inclusive: true };
      }
      case "n":
      case "N":
        if (!this.lastSearch) throw BAD;
        return { pos: this.searchPos(t, cur, n, k === "N") };
      case "*":
      case "#": {
        const r = this.wordAt(t, cur);
        if (!r) throw BAD;
        this.lastSearch = { term: t.slice(r.from, r.to), back: k === "#", word: true };
        return { pos: this.searchPos(t, k === "#" ? r.from : r.to - 1, n, false) };
      }
      default:
        return null;
    }
  }

  private find(t: string, cur: number, k: string, c: string, n: number, again = false): Motion {
    const ls = this.lineStart(t, cur);
    const le = this.lineEnd(t, cur);
    let p = cur;
    const fwd = k === "f" || k === "t";
    for (let j = 0; j < n; j++) {
      // ; after t/T would find the same character again: start one further
      const from = fwd ? p + 1 + (again && k === "t" && j === 0 ? 1 : 0) : p - 1 - (again && k === "T" && j === 0 ? 1 : 0);
      const q = fwd ? t.indexOf(c, from) : t.lastIndexOf(c, from);
      if (q < 0 || (fwd ? q >= le : q < ls)) throw BAD;
      p = q;
    }
    if (k === "t") p--;
    if (k === "T") p++;
    this.goal = null;
    return { pos: p, inclusive: fwd };
  }

  /** The start of the next word (the end of the text after the last). An empty line is a word. */
  private wordStart(t: string, p: number, big: boolean): number {
    const len = t.length;
    if (p >= len) return len;
    const c = cls(t[p], big);
    if (c !== 0) while (p < len && cls(t[p], big) === c) p++;
    while (p < len && cls(t[p], big) === 0) {
      if (t[p] === "\n" && (t[p + 1] === "\n" || p + 1 === len)) return p + 1 < len ? p + 1 : len;
      p++;
    }
    return p;
  }

  private wordEnd(t: string, p: number, big: boolean): number {
    const len = t.length;
    p++;
    while (p < len && cls(t[p], big) === 0) p++;
    if (p >= len) return Math.max(0, len - 1);
    const c = cls(t[p], big);
    while (p + 1 < len && cls(t[p + 1], big) === c) p++;
    return p;
  }

  private wordBack(t: string, p: number, big: boolean): number {
    if (p <= 0) return 0;
    p--;
    while (p > 0 && cls(t[p], big) === 0) {
      if (t[p] === "\n" && t[p - 1] === "\n") return p;
      p--;
    }
    const c = cls(t[p], big);
    while (p > 0 && cls(t[p - 1], big) === c && c !== 0) p--;
    return p;
  }

  private paraFwd(t: string, p: number): number {
    let ls = this.lineStart(t, p);
    // past blank lines, then to the next blank line
    while (ls < t.length && this.blankLine(t, ls)) ls = this.lineEnd(t, ls) + 1;
    while (ls < t.length) {
      if (this.blankLine(t, ls)) return ls;
      const le = this.lineEnd(t, ls);
      if (le >= t.length) return Math.max(this.lineStart(t, t.length), t.length);
      ls = le + 1;
    }
    return t.length;
  }

  private paraBack(t: string, p: number): number {
    let ls = this.lineStart(t, p);
    while (ls > 0 && this.blankLine(t, ls)) ls = this.lineStart(t, ls - 1);
    while (ls > 0) {
      ls = this.lineStart(t, ls - 1);
      if (this.blankLine(t, ls)) return ls;
    }
    return 0;
  }

  private matchBracket(t: string, cur: number): number | null {
    const le = this.lineEnd(t, cur);
    let p = cur;
    while (p < le && !"()[]{}".includes(t[p]!)) p++;
    if (p >= le) return null;
    const c = t[p]!;
    const open = "([{".includes(c);
    const [o, cl] = PAIRS[c]!;
    let depth = 0;
    for (let q = p; open ? q < t.length : q >= 0; q += open ? 1 : -1) {
      if (t[q] === o) depth += open ? 1 : -1;
      else if (t[q] === cl) depth += open ? -1 : 1;
      if (depth === 0) return q;
    }
    return null;
  }

  private searchPos(t: string, cur: number, n: number, reverse: boolean): number {
    const s = this.lastSearch!;
    const back = s.back !== reverse;
    // smartcase: a lowercase term matches any case (not for * and #, like Vim)
    const ci = !s.word && s.term === s.term.toLowerCase();
    const hay = ci ? t.toLowerCase() : t;
    const needle = ci ? s.term.toLowerCase() : s.term;
    const hits: number[] = [];
    if (needle) {
      for (let q = hay.indexOf(needle); q >= 0; q = hay.indexOf(needle, q + 1)) {
        if (!s.word || (cls(t[q - 1], false) !== 1 && cls(t[q + needle.length], false) !== 1)) hits.push(q);
      }
    }
    if (!hits.length) {
      this.h.message?.(`Pattern not found: ${s.term}`);
      throw BAD;
    }
    let p = cur;
    for (let j = 0; j < n; j++) {
      if (back) p = [...hits].reverse().find((q) => q < p) ?? hits[hits.length - 1]!;
      else p = hits.find((q) => q > p) ?? hits[0]!;
    }
    return p;
  }

  private jumpSearch(n: number, reverse: boolean): void {
    const t = this.h.text();
    try {
      const p = this.searchPos(t, this.caret(), n, reverse);
      if (this.mode === "visual" || this.mode === "vline") {
        this.vHead = p;
        this.showVisual();
      } else this.select(this.clampNormal(t, p));
    } catch (e) {
      if (e !== BAD) throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Text objects

  private textObject(t: string, cur: number, around: boolean, k: string): Range {
    if (k === "w" || k === "W") {
      const big = k === "W";
      const ls = this.lineStart(t, cur);
      const le = this.lineEnd(t, cur);
      if (cur >= le && le > ls) cur = le - 1;
      const c = cls(t[cur], big);
      let a = cur;
      let b = cur;
      while (a > ls && cls(t[a - 1], big) === c) a--;
      while (b < le && cls(t[b], big) === c) b++;
      if (around) {
        if (c !== 0) {
          let e = b;
          while (e < le && cls(t[e], big) === 0) e++;
          if (e > b) b = e;
          else while (a > ls && cls(t[a - 1], big) === 0) a--;
        } else {
          const c2 = cls(t[b], big);
          while (b < le && cls(t[b], big) === c2 && c2 !== 0) b++;
        }
      }
      return { from: a, to: b };
    }
    if (k === '"' || k === "'" || k === "`") {
      const ls = this.lineStart(t, cur);
      const line = t.slice(ls, this.lineEnd(t, cur));
      const qs: number[] = [];
      for (let j = 0; j < line.length; j++) if (line[j] === k && line[j - 1] !== "\\") qs.push(ls + j);
      for (let j = 0; j + 1 < qs.length; j += 2) {
        const [a, b] = [qs[j]!, qs[j + 1]!];
        if (cur <= b) return around ? { from: a, to: b + 1 } : { from: a + 1, to: b };
      }
      throw BAD;
    }
    if (k === "p") {
      let a = this.lineStart(t, cur);
      const blank = this.blankLine(t, a);
      while (a > 0 && this.blankLine(t, this.lineStart(t, a - 1)) === blank) a = this.lineStart(t, a - 1);
      let b = this.lineStart(t, cur);
      const nextLine = (ls: number) => {
        const le = this.lineEnd(t, ls);
        return le < t.length ? le + 1 : null;
      };
      for (let q = nextLine(b); q !== null && this.blankLine(t, q) === blank; q = nextLine(q)) b = q;
      if (around) for (let q = nextLine(b); q !== null && this.blankLine(t, q) !== blank; q = nextLine(q)) {
        if (!this.blankLine(t, q)) break;
        b = q;
      }
      return { from: a, to: b, linewise: true };
    }
    const pair = PAIRS[k];
    if (!pair) throw BAD;
    const [o, c] = pair;
    let depth = 0;
    let a = -1;
    for (let q = t[cur] === c ? cur - 1 : cur; q >= 0; q--) {
      if (t[q] === c && q !== cur) depth++;
      else if (t[q] === o) {
        if (depth === 0) {
          a = q;
          break;
        }
        depth--;
      }
    }
    if (a < 0) throw BAD;
    depth = 0;
    let b = -1;
    for (let q = a + 1; q < t.length; q++) {
      if (t[q] === o) depth++;
      else if (t[q] === c) {
        if (depth === 0) {
          b = q;
          break;
        }
        depth--;
      }
    }
    if (b < 0) throw BAD;
    return around ? { from: a, to: b + 1 } : { from: a + 1, to: b };
  }

  private wordAt(t: string, cur: number): Range | null {
    const le = this.lineEnd(t, cur);
    let p = cur;
    while (p < le && cls(t[p], false) !== 1) p++;
    if (p >= le) return null;
    let a = p;
    let b = p;
    while (a > 0 && cls(t[a - 1], false) === 1) a--;
    while (b < t.length && cls(t[b], false) === 1) b++;
    return { from: a, to: b };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Operators and changes

  private charRange(cur: number, pos: number, inclusive: boolean, t: string): Range {
    const a = Math.min(cur, pos);
    let b = Math.max(cur, pos);
    if (inclusive) b = Math.min(b + 1, t.length);
    return { from: a, to: b };
  }

  /** [from, to) of a range; a linewise one is its whole lines, without the last newline. */
  private span(t: string, r: Range): [number, number] {
    if (!r.linewise) return [r.from, r.to];
    const a = Math.min(r.from, r.to);
    const b = Math.max(r.from, r.to);
    return [this.lineStart(t, a), this.lineEnd(t, b)];
  }

  private operate(op: string, r: Range, cur: number): void {
    const t = this.h.text();
    const [from, to] = this.span(t, r);
    if (op === "y") {
      this.yank(t.slice(from, to) + (r.linewise ? "\n" : ""), !!r.linewise);
      const back = r.linewise ? (this.lineStart(t, cur) === from ? cur : from) : Math.min(from, cur);
      this.select(this.clampNormal(t, back));
      return;
    }
    this.writable();
    this.changed = true;
    if (op === ">" || op === "<") {
      const ls = this.lineStart(t, Math.min(from, to));
      const le = this.lineEnd(t, Math.max(from, to - (r.linewise || to === from ? 0 : 1)));
      const lines = t.slice(ls, le).split("\n");
      const out = lines.map((l) => (op === ">" ? (l.trim() ? "  " + l : l) : l.replace(/^( {1,2}|\t)/, ""))).join("\n");
      this.h.replace(ls, le, out);
      this.select(this.firstNonBlank(ls));
      return;
    }
    const text = t.slice(from, to);
    if (r.linewise) {
      if (op === "c") {
        this.register = { text: text + "\n", linewise: true };
        const indent = /^[ \t]*/.exec(text)![0];
        this.h.replace(from, to, indent);
        this.select(from + indent.length);
        this.mode = "insert";
        return;
      }
      this.register = { text: text + "\n", linewise: true };
      if (to < t.length) this.h.replace(from, to + 1, "");
      else if (from > 0) this.h.replace(from - 1, to, "");
      else this.h.replace(from, to, "");
      const nt = this.h.text();
      const at = Math.min(from, nt.length);
      this.select(this.firstNonBlank(this.lineStart(nt, to < t.length || from === 0 ? at : Math.max(0, from - 1))));
      return;
    }
    if (text) this.register = { text, linewise: false };
    this.h.replace(from, to, "");
    if (op === "c") {
      this.select(from);
      this.mode = "insert";
      return;
    }
    this.select(this.clampNormal(this.h.text(), from));
  }

  private yank(text: string, linewise: boolean): void {
    this.register = { text, linewise };
    this.h.yanked?.(text);
  }

  private put(before: boolean, n: number): void {
    this.writable();
    const { text, linewise } = this.register;
    if (!text) throw BAD;
    const t = this.h.text();
    const cur = this.caret();
    this.changed = true;
    if (linewise) {
      const body = text.repeat(n);
      if (before) {
        const ls = this.lineStart(t, cur);
        this.h.replace(ls, ls, body);
        this.select(this.firstNonBlank(ls));
      } else {
        const le = this.lineEnd(t, cur);
        this.h.replace(le, le, "\n" + body.replace(/\n$/, ""));
        this.select(this.firstNonBlank(le + 1));
      }
      return;
    }
    const at = before ? cur : Math.min(cur + 1, this.lineEnd(t, cur));
    const body = text.repeat(n);
    this.h.replace(at, at, body);
    this.select(this.clampNormal(this.h.text(), at + body.length - 1));
  }

  private join(cur: number, lines: number): void {
    this.writable();
    let t = this.h.text();
    let le = this.lineEnd(t, cur);
    let at = le;
    for (let j = 1; j < lines; j++) {
      if (le >= t.length) {
        if (j === 1) throw BAD;
        break;
      }
      let e = le + 1;
      while (e < t.length && (t[e] === " " || t[e] === "\t")) e++;
      const lineBefore = t.slice(this.lineStart(t, le), le);
      const sep = e >= t.length || t[e] === "\n" || t[e] === ")" || lineBefore === "" || /\s$/.test(lineBefore) ? "" : " ";
      this.h.replace(le, e, sep);
      at = le;
      t = this.h.text();
      le = this.lineEnd(t, le + sep.length);
    }
    this.changed = true;
    this.select(this.clampNormal(t, at));
  }

  private insertAt(p: number): void {
    this.writable();
    this.select(p);
    this.changed = true;
    this.mode = "insert";
  }

  private leaveInsert(): void {
    this.mode = "normal";
    if (this.recording) {
      const before = this.recording.text;
      const after = this.h.text();
      let pre = 0;
      while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
      let suf = 0;
      while (suf < before.length - pre && suf < after.length - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
      this.lastChange = { keys: this.recording.keys, insert: after.slice(pre, after.length - suf) };
      this.recording = null;
    }
    const t = this.h.text();
    const cur = this.caret();
    this.select(this.clampNormal(t, cur > this.lineStart(t, cur) ? cur - 1 : cur));
  }

  private repeat(n: number): void {
    const last = this.lastChange;
    if (!last) throw BAD;
    this.replaying = true;
    try {
      for (let j = 0; j < n; j++) {
        this.buf = [];
        if (this.run(last.keys) !== "done") break;
        if (this.mode === "insert") {
          const cur = this.caret();
          if (last.insert) {
            this.h.replace(cur, cur, last.insert);
            this.select(cur + last.insert.length);
          }
          this.mode = "normal";
          const t = this.h.text();
          const c = this.caret();
          this.select(this.clampNormal(t, c > this.lineStart(t, c) ? c - 1 : c));
        }
      }
    } finally {
      this.replaying = false;
      this.changed = false;
    }
  }

  private writable(): void {
    if (this.h.readOnly()) throw BAD;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Selection and lines

  private caret(): number {
    return this.mode === "visual" || this.mode === "vline" ? this.vHead : this.h.sel().head;
  }

  private select(p: number): void {
    this.h.select(p, p);
  }

  private clampCaret(): void {
    const t = this.h.text();
    const s = this.h.sel();
    const p = this.clampNormal(t, s.head);
    if (p !== s.head || s.anchor !== s.head) this.select(p);
  }

  /** Normal mode's caret is on a character: not on the newline of a line that has some. */
  private clampNormal(t: string, p: number): number {
    p = Math.max(0, Math.min(p, t.length));
    const ls = this.lineStart(t, p);
    if (p > ls && (p === t.length || t[p] === "\n")) return p - 1;
    return p;
  }

  private showVisual(): void {
    const t = this.h.text();
    const a = this.vAnchor;
    const h = this.vHead;
    if (this.mode === "vline") {
      if (h >= a) this.h.select(this.lineStart(t, a), this.lineEnd(t, h));
      else this.h.select(this.lineEnd(t, a), this.lineStart(t, h));
      return;
    }
    if (h >= a) this.h.select(a, Math.min(h + 1, t.length));
    else this.h.select(Math.min(a + 1, t.length), h);
  }

  private leaveVisual(p: number): void {
    this.mode = "normal";
    this.select(this.clampNormal(this.h.text(), p));
  }

  private atGoal(t: string, cur: number, ls: number): number {
    if (this.goal === null) this.goal = cur - this.lineStart(t, cur);
    const le = this.lineEnd(t, ls);
    const max = this.mode === "normal" ? Math.max(ls, le - 1) : le;
    return Math.min(ls + Math.min(this.goal, le - ls), max);
  }

  private lineStart(t: string, p: number): number {
    return t.lastIndexOf("\n", p - 1) + 1;
  }

  private lineEnd(t: string, p: number): number {
    const e = t.indexOf("\n", p);
    return e < 0 ? t.length : e;
  }

  /** The line's first character that isn't blank, after its list or quote marker if it has one (^, I, gg, dd). */
  private firstNonBlank(ls: number): number {
    const t = this.h.text();
    let p = Math.max(ls, this.h.textStart?.(ls) ?? ls);
    while (p < t.length && (t[p] === " " || t[p] === "\t")) p++;
    return p;
  }

  /**
   * Move the caret to `p`, coming from `from`. The editor keeps the caret out of some places (inside a list marker, a
   * collapsed link): when it puts it back where it came from (or behind), go on in the same direction until it
   * moves, so l and w step over such a piece instead of sticking at its edge.
   */
  private land(p: number, from: number): void {
    const t = this.h.text();
    p = this.clampNormal(t, this.overMarker(p, from));
    this.select(p);
    const dir = Math.sign(p - from);
    if (!dir) return;
    for (let q = p, i = 0; i < 2000 && (this.h.sel().head - from) * dir <= 0; i++) {
      q += dir;
      if (q < 0 || q > t.length) {
        this.select(from);
        return;
      }
      this.select(q);
    }
  }

  /**
   * `p`, or past the marker it fell inside (`1.` of "1. item": the editor wouldn't keep the caret there): on to the
   * line's text when moving forward from `from`, back to the marker's start when moving back.
   */
  private overMarker(p: number, from: number): number {
    const ts = this.h.textStart?.(p);
    if (ts === undefined) return p;
    const ls = this.lineStart(this.h.text(), p);
    if (p <= ls || p >= ts) return p;
    return p > from ? ts : ls;
  }

  private lastNonBlank(t: string, p: number): number {
    let e = this.lineEnd(t, p) - 1;
    const ls = this.lineStart(t, p);
    while (e > ls && /\s/.test(t[e]!)) e--;
    return e;
  }

  private blankLine(t: string, ls: number): boolean {
    return t.slice(ls, this.lineEnd(t, ls)).trim() === "";
  }

  /** The start of the line `d` lines below (above, negative) the one holding `p`; at the edge: null, or the edge line when `clamp`. */
  private lineDown(t: string, p: number, d: number, clamp: true): number;
  private lineDown(t: string, p: number, d: number, clamp: boolean): number | null;
  private lineDown(t: string, p: number, d: number, clamp: boolean): number | null {
    let ls = this.lineStart(t, p);
    for (let j = 0; j < Math.abs(d); j++) {
      if (d > 0) {
        const le = this.lineEnd(t, ls);
        if (le >= t.length) return clamp ? ls : null;
        ls = le + 1;
      } else {
        if (ls === 0) return clamp ? 0 : null;
        ls = this.lineStart(t, ls - 1);
      }
    }
    return ls;
  }

  private lineStartOfLine(t: string, line: number): number {
    return this.lineDown(t, 0, Math.max(0, line), true);
  }
}

function swapCase(s: string): string {
  let out = "";
  for (const ch of s) {
    const up = ch.toUpperCase();
    out += ch === up ? ch.toLowerCase() : up;
  }
  return out;
}

/** A keydown as a Vim key, or null for keys Vim leaves alone (Cmd shortcuts, modifiers alone, function keys). */
export function vimKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string | null {
  if (e.metaKey) return null;
  if (e.ctrlKey) {
    if (e.key === "[") return "<Esc>";
    if (e.key === "r" || e.key === "d" || e.key === "u") return `<C-${e.key}>`;
    return null;
  }
  switch (e.key) {
    case "Escape":
      return "<Esc>";
    case "Enter":
      return "<CR>";
    case "Backspace":
      return "<BS>";
    case "ArrowLeft":
      return "h";
    case "ArrowRight":
      return "l";
    case "ArrowUp":
      return "k";
    case "ArrowDown":
      return "j";
  }
  if (e.altKey) return null;
  return [...e.key].length === 1 ? e.key : null;
}
