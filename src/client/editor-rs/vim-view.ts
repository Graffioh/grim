// Vim mode on a RustEditorView: VimCore (vim.ts) on the engine, a block cursor in normal and Visual mode, and a mode
// line at the bottom right of the window (NORMAL, INSERT, VISUAL, V-LINE, the keys pending, the search line). It
// follows the setting (vimEnabled) live; off, it takes no keys and draws nothing.

import { VimCore, VIM_EVENT, vimEnabled, vimKey, type VimHost } from "./vim.ts";
import { scrollBy, visibleBounds } from "./layout.ts";
import { lineAt } from "./offsets.ts";
import type { RustEditorView } from "./view.ts";

const MODE_LABEL = { normal: "NORMAL", insert: "INSERT", visual: "VISUAL", vline: "V-LINE" } as const;

export class VimView {
  readonly core: VimCore;
  private on = vimEnabled();
  private readonly caret: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly keys: HTMLSpanElement;
  private prompting: HTMLInputElement | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onSetting = () => this.setOn(vimEnabled());
  private readonly onFocus = () => this.refresh();

  constructor(private readonly v: RustEditorView) {
    const engine = v.engine;
    const host: VimHost = {
      text: () => v.doc.text,
      sel: () => ({ ...v.sel }),
      select: (anchor, head) => {
        const len = v.doc.text.length;
        const p = engine.set_selection(Math.min(anchor, len), Math.min(head, len));
        v.apply({ ...p, scroll: "caret" });
      },
      replace: (from, to, text) => v.apply(engine.replace_range(from, to, text)),
      undo: () => v.apply(engine.undo()),
      redo: () => v.apply(engine.redo()),
      enter: () => {
        v.apply(engine.key("Enter", 0, v.layout));
        v.onEnter?.();
      },
      readOnly: () => v.readOnly,
      displayLine: (pos, dir, goalX) => {
        const layout = v.layout;
        const x = goalX ?? layout.caret_rect(pos)[0];
        const y = layout.adjacent_line_y(pos, dir);
        if (y === null) return null;
        if (y !== undefined) {
          const p = layout.hit_test(x, y);
          if (p !== undefined && p !== pos) return { pos: p, x };
        }
        // the layout can't tell (lines not drawn yet): the editor's own arrow key
        v.apply(engine.set_selection(pos, pos));
        const p = engine.key(dir > 0 ? "ArrowDown" : "ArrowUp", 0, layout);
        if (!p) return null;
        v.apply(p);
        return v.sel.head === pos ? null : { pos: v.sel.head, x };
      },
      halfPage: () => Math.max(1, Math.round(window.innerHeight / 2 / 27)),
      scroll: (where) => {
        const r = v.caretRect(v.sel.head);
        const [top, bottom] = visibleBounds(v.wrapper);
        const dy = where === "top" ? r.top - top - 8 : where === "bottom" ? r.bottom - bottom + 8 : (r.top + r.bottom) / 2 - (top + bottom) / 2;
        scrollBy(v.wrapper, dy);
      },
      prompt: (kind, done) => this.prompt(kind, done),
      yanked: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
      textStart: (pos) => {
        const i = lineAt(v.doc.lines, pos);
        const span = v.doc.lines[i];
        const line = v.lines[i];
        return span && line && v.lines.length === v.doc.lines.length ? span.from + line.textFrom : pos;
      },
      message: (text) => this.message(text),
    };
    this.core = new VimCore(host);

    this.caret = document.createElement("div");
    this.caret.className = "mde-vim-caret";
    this.caret.setAttribute("aria-hidden", "true");
    v.wrapper.appendChild(this.caret);

    this.bar = document.createElement("div");
    this.bar.className = "mde-vim-bar";
    this.bar.setAttribute("aria-live", "polite");
    this.label = document.createElement("span");
    this.label.className = "mde-vim-mode";
    this.keys = document.createElement("span");
    this.keys.className = "mde-vim-keys";
    this.bar.append(this.label, this.keys);
    document.body.appendChild(this.bar);

    addEventListener(VIM_EVENT, this.onSetting);
    v.root.addEventListener("focus", this.onFocus);
    v.root.addEventListener("blur", this.onFocus);
    this.setOn(this.on);
  }

  /** A keydown on the editor: true if Vim took it (the editor must not see it). */
  onKeyDown(e: KeyboardEvent): boolean {
    if (!this.on) return false;
    const k = vimKey(e);
    const typing = this.core.mode === "insert";
    if (k === null) {
      // in normal and Visual mode a character (Option-letters too) must not be typed into the note
      if (!typing && !e.metaKey && !e.ctrlKey && [...e.key].length === 1) {
        e.preventDefault();
        return true;
      }
      return false;
    }
    // in insert mode, Return, Backspace and the arrows are the editor's
    if (typing && k !== "<Esc>") return false;
    if (!this.core.key(k)) return false;
    e.preventDefault();
    this.refresh();
    return true;
  }

  private setOn(on: boolean): void {
    this.on = on;
    if (on) this.core.reset();
    this.refresh();
  }

  /** Mode line, native caret and block cursor after a key, a mode change or focus. */
  refresh(): void {
    const block = this.on && this.core.mode !== "insert";
    this.v.root.classList.toggle("vim-block", block);
    const focused = this.on && (document.activeElement === this.v.root || this.prompting !== null);
    this.bar.classList.toggle("show", focused);
    this.bar.classList.toggle("insert", this.core.mode === "insert");
    if (!this.prompting) {
      this.label.textContent = MODE_LABEL[this.core.mode];
      if (!this.msgTimer || this.core.pending) this.keys.textContent = this.core.pending;
    }
    this.draw();
  }

  /** The block cursor over the character at the caret (normal and Visual mode, focused). */
  draw(): void {
    const v = this.v;
    const show = this.on && this.core.mode !== "insert" && document.activeElement === v.root;
    if (!show) {
      this.caret.style.display = "none";
      return;
    }
    const s = v.sel;
    // in Visual mode the cursor is the selection's moving end, on its last character when it runs forward
    const pos = s.head > s.anchor ? s.head - 1 : s.head;
    const r = v.caretRect(pos);
    if (r.bottom - r.top <= 0) {
      this.caret.style.display = "none";
      return;
    }
    let w = 0;
    const t = v.doc.text;
    if (pos < t.length && t[pos] !== "\n") {
      const r2 = v.caretRect(pos + 1);
      if (Math.abs(r2.top - r.top) < 2) w = r2.left - r.left;
    }
    const base = v.wrapper.getBoundingClientRect();
    const st = this.caret.style;
    st.display = "block";
    st.left = `${r.left - base.left}px`;
    st.top = `${r.top - base.top}px`;
    st.height = `${r.bottom - r.top}px`;
    st.width = `${Math.max(w, 8)}px`;
  }

  private prompt(kind: "/" | "?" | ":", done: (s: string | null) => void): void {
    const input = document.createElement("input");
    input.className = "mde-vim-input";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("aria-label", kind === ":" ? "Command" : "Search");
    this.prompting = input;
    this.label.textContent = kind;
    this.keys.replaceChildren(input);
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      this.prompting = null;
      this.keys.replaceChildren();
      this.v.focus();
      done(value);
      this.refresh();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === "Escape" || (e.key === "[" && e.ctrlKey) || (e.key === "Backspace" && !input.value)) {
        e.preventDefault();
        finish(null);
      }
    });
    input.addEventListener("blur", () => finish(null));
    this.refresh();
    input.focus();
  }

  private message(text: string): void {
    this.keys.textContent = text;
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = setTimeout(() => {
      this.msgTimer = null;
      if (!this.prompting) this.keys.textContent = this.core.pending;
    }, 2500);
  }

  destroy(): void {
    removeEventListener(VIM_EVENT, this.onSetting);
    this.v.root.removeEventListener("focus", this.onFocus);
    this.v.root.removeEventListener("blur", this.onFocus);
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.caret.remove();
    this.bar.remove();
  }
}
