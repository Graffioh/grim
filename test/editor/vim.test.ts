import { describe, expect, test } from "bun:test";
import { VimCore, vimKey, type VimHost } from "../../src/client/editor-rs/vim.ts";

/** A plain-string editor: `|` in `text` marks the caret. Undo keeps whole snapshots. */
function setup(text: string, opts: { readOnly?: boolean } = {}) {
  const at = text.indexOf("|");
  let t = text.replace("|", "");
  let sel = { anchor: at, head: at };
  const undo: { t: string; head: number }[] = [];
  const redo: { t: string; head: number }[] = [];
  const yanks: string[] = [];
  const host: VimHost = {
    text: () => t,
    sel: () => ({ ...sel }),
    select: (anchor, head) => void (sel = { anchor, head }),
    replace: (from, to, s) => {
      undo.push({ t, head: sel.head });
      redo.length = 0;
      t = t.slice(0, from) + s + t.slice(to);
    },
    undo: () => {
      const u = undo.pop();
      if (!u) return;
      redo.push({ t, head: sel.head });
      t = u.t;
      sel = { anchor: u.head, head: u.head };
    },
    redo: () => {
      const r = redo.pop();
      if (!r) return;
      undo.push({ t, head: sel.head });
      t = r.t;
    },
    enter: () => {
      t = t.slice(0, sel.head) + "\n" + t.slice(sel.head);
      sel = { anchor: sel.head + 1, head: sel.head + 1 };
    },
    readOnly: () => !!opts.readOnly,
    yanked: (s) => void yanks.push(s),
  };
  const vim = new VimCore(host);
  /** Type keys: plain characters, or <Esc>-style names. In insert mode, unconsumed characters are typed. */
  const type = (keys: string) => {
    for (const k of keys.match(/<[^>]+>|[\s\S]/gu) ?? []) {
      if (vim.key(k)) continue;
      host.replace(sel.head, sel.head, k);
      sel = { anchor: sel.head + 1, head: sel.head + 1 };
    }
  };
  const show = () => (sel.anchor === sel.head ? t.slice(0, sel.head) + "|" + t.slice(sel.head) : `${t} [${sel.anchor},${sel.head}]`);
  return { vim, type, show, yanks, text: () => t };
}

describe("vim motions", () => {
  test("h j k l keep the column", () => {
    const e = setup("ab|cd\nx\nefgh");
    e.type("j");
    expect(e.show()).toBe("abcd\n|x\nefgh");
    e.type("j");
    expect(e.show()).toBe("abcd\nx\nef|gh");
    e.type("kk");
    expect(e.show()).toBe("ab|cd\nx\nefgh");
    e.type("l");
    expect(e.show()).toBe("abc|d\nx\nefgh");
    e.type("ll");
    expect(e.show()).toBe("abc|d\nx\nefgh"); // not onto the newline
  });

  test("words", () => {
    const e = setup("|foo bar.baz  qux\nnext");
    e.type("w");
    expect(e.show()).toBe("foo |bar.baz  qux\nnext");
    e.type("w");
    expect(e.show()).toBe("foo bar|.baz  qux\nnext");
    e.type("W");
    expect(e.show()).toBe("foo bar.baz  |qux\nnext");
    e.type("w");
    expect(e.show()).toBe("foo bar.baz  qux\n|next");
    e.type("b");
    expect(e.show()).toBe("foo bar.baz  |qux\nnext");
    e.type("B");
    expect(e.show()).toBe("foo |bar.baz  qux\nnext");
    e.type("e");
    expect(e.show()).toBe("foo ba|r.baz  qux\nnext");
    e.type("2w");
    expect(e.show()).toBe("foo bar.|baz  qux\nnext");
  });

  test("line motions, gg and G", () => {
    const e = setup("  one\n|two three\nfour");
    e.type("$");
    expect(e.show()).toBe("  one\ntwo thre|e\nfour");
    e.type("0");
    expect(e.show()).toBe("  one\n|two three\nfour");
    e.type("gg");
    expect(e.show()).toBe("  |one\ntwo three\nfour");
    e.type("G");
    expect(e.show()).toBe("  one\ntwo three\n|four");
    e.type("2G");
    expect(e.show()).toBe("  one\n|two three\nfour");
  });

  test("f t ; , and %", () => {
    const e = setup("|a(b, c(d)), e");
    e.type("f,");
    expect(e.show()).toBe("a(b|, c(d)), e");
    e.type(";");
    expect(e.show()).toBe("a(b, c(d))|, e");
    e.type(",");
    expect(e.show()).toBe("a(b|, c(d)), e");
    e.type("0%");
    expect(e.show()).toBe("a(b, c(d)|), e");
    e.type("%");
    expect(e.show()).toBe("a|(b, c(d)), e");
    e.type("tc");
    expect(e.show()).toBe("a(b,| c(d)), e");
  });

  test("paragraphs", () => {
    const e = setup("|a\nb\n\nc\n\n\nd");
    e.type("}");
    expect(e.show()).toBe("a\nb\n|\nc\n\n\nd");
    e.type("}");
    expect(e.show()).toBe("a\nb\n\nc\n|\n\nd");
    e.type("{");
    expect(e.show()).toBe("a\nb\n|\nc\n\n\nd");
  });

  test("search with / n N, * and #", () => {
    const e = setup("|foo bar\nFoo foobar foo");
    e.vim.searchFor("foo", false);
    expect(e.show()).toBe("foo bar\n|Foo foobar foo");
    e.type("n");
    expect(e.show()).toBe("foo bar\nFoo |foobar foo");
    e.type("N");
    expect(e.show()).toBe("foo bar\n|Foo foobar foo");
    e.type("gg*");
    expect(e.show()).toBe("foo bar\nFoo foobar |foo"); // whole word, case-sensitive
    e.type("#");
    expect(e.show()).toBe("|foo bar\nFoo foobar foo");
  });
});

describe("vim operators", () => {
  test("dw, cw, d$, dd with counts, and p", () => {
    const e = setup("|one two three\nfour\nfive");
    e.type("dw");
    expect(e.show()).toBe("|two three\nfour\nfive");
    e.type("cwTWO<Esc>");
    expect(e.show()).toBe("TW|O three\nfour\nfive");
    e.type("d$");
    expect(e.show()).toBe("T|W\nfour\nfive");
    e.type("2dd");
    expect(e.show()).toBe("|five");
    e.type("p");
    expect(e.show()).toBe("five\n|TW\nfour");
    e.type("P");
    expect(e.show()).toBe("five\n|TW\nfour\nTW\nfour");
  });

  test("dw at the end of a line keeps the newline", () => {
    const e = setup("one |two\nthree");
    e.type("dw");
    expect(e.show()).toBe("one| \nthree");
  });

  test("dd on the last line, and yy p", () => {
    const e = setup("a\n|b");
    e.type("dd");
    expect(e.show()).toBe("|a");
    e.type("yyp");
    expect(e.show()).toBe("a\n|a");
    expect(e.yanks).toEqual(["a\n"]);
  });

  test("text objects", () => {
    const e = setup('say "hel|lo there" (a [b] c)');
    e.type('ci"x<Esc>');
    expect(e.show()).toBe('say "|x" (a [b] c)');
    e.type("fbdi(");
    expect(e.show()).toBe('say "x" (|)');
    const f = setup("one tw|o three");
    f.type("daw");
    expect(f.show()).toBe("one |three");
    const g = setup("a\n|b\nc\n\nd");
    g.type("dap");
    expect(g.show()).toBe("|d");
  });

  test("x X s r ~ J", () => {
    const e = setup("|abc def\n  ghi");
    e.type("x");
    expect(e.show()).toBe("|bc def\n  ghi");
    e.type("$X");
    expect(e.show()).toBe("bc d|f\n  ghi");
    e.type("0rZ");
    expect(e.show()).toBe("|Zc df\n  ghi");
    e.type("~");
    expect(e.show()).toBe("z|c df\n  ghi");
    e.type("J");
    expect(e.show()).toBe("zc df| ghi");
    e.type("0sY<Esc>");
    expect(e.show()).toBe("|Yc df ghi");
  });

  test("indent with >> and <<", () => {
    const e = setup("|- a\n- b");
    e.type(">j");
    expect(e.text()).toBe("  - a\n  - b");
    e.type("<<");
    expect(e.text()).toBe("- a\n  - b");
  });

  test("o O A I and insert with Escape", () => {
    const e = setup("|ab\ncd");
    e.type("onew<Esc>");
    expect(e.show()).toBe("ab\nne|w\ncd");
    e.type("Otop<Esc>");
    expect(e.show()).toBe("ab\nto|p\nnew\ncd");
    e.type("A!<Esc>");
    expect(e.show()).toBe("ab\ntop|!\nnew\ncd");
    e.type("I-<Esc>");
    expect(e.show()).toBe("ab\n|-top!\nnew\ncd");
  });

  test("undo, redo and dot repeat", () => {
    const e = setup("|a b c d");
    e.type("dw");
    expect(e.show()).toBe("|b c d");
    e.type(".");
    expect(e.show()).toBe("|c d");
    e.type("u");
    expect(e.text()).toBe("b c d");
    e.type("<C-r>");
    expect(e.text()).toBe("c d");
    e.type("cwX<Esc>w.");
    expect(e.text()).toBe("X X");
  });

  test("visual mode", () => {
    const e = setup("|one two\nthree");
    e.type("vey");
    expect(e.yanks).toEqual(["one"]);
    expect(e.show()).toBe("|one two\nthree");
    e.type("wvlld");
    expect(e.show()).toBe("one| \nthree");
    e.type("Vjd");
    expect(e.show()).toBe("|");
    const f = setup("a |bc d");
    f.type("viwU");
    expect(f.show()).toBe("a |BC d");
    f.type("v");
    expect(f.show()).toBe("a BC d [2,3]");
    f.type("<Esc>");
    expect(f.show()).toBe("a |BC d");
  });

  test("read-only: motions work, changes don't", () => {
    const e = setup("|ab cd", { readOnly: true });
    e.type("wdd");
    expect(e.show()).toBe("ab |cd");
    e.type("i");
    expect(e.vim.mode).toBe("normal");
  });

  test("pending keys and counts", () => {
    const e = setup("|abc");
    e.type("2d");
    expect(e.vim.pending).toBe("2d");
    e.type("<Esc>");
    expect(e.vim.pending).toBe("");
    expect(e.text()).toBe("abc");
  });
});

test("vimKey", () => {
  const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => vimKey({ key, ctrlKey: false, metaKey: false, altKey: false, ...m });
  expect(k("a")).toBe("a");
  expect(k("Escape")).toBe("<Esc>");
  expect(k("[", { ctrlKey: true })).toBe("<Esc>");
  expect(k("r", { ctrlKey: true })).toBe("<C-r>");
  expect(k("c", { metaKey: true })).toBeNull();
  expect(k("Shift")).toBeNull();
  expect(k("ArrowDown")).toBe("j");
});

describe("j and k by shown lines", () => {
  /** A host whose lines wrap every 5 characters: x is the column within the shown line. */
  function wrapped(text: string) {
    const at = text.indexOf("|");
    let t = text.replace("|", "");
    let sel = { anchor: at, head: at };
    const rows = () => {
      const out: { from: number; to: number }[] = [];
      let ls = 0;
      for (const line of t.split("\n")) {
        for (let o = 0; o === 0 || o < line.length; o += 5) out.push({ from: ls + o, to: ls + Math.min(o + 5, line.length) });
        ls += line.length + 1;
      }
      return out;
    };
    const rowOf = (p: number) => rows().findIndex((r, i, all) => p >= r.from && (p < r.to || i === all.length - 1 || all[i + 1]!.from > p));
    const host: VimHost = {
      text: () => t,
      sel: () => ({ ...sel }),
      select: (anchor, head) => void (sel = { anchor, head }),
      replace: (from, to, s) => void (t = t.slice(0, from) + s + t.slice(to)),
      undo: () => {},
      redo: () => {},
      enter: () => {},
      readOnly: () => false,
      displayLine: (pos, dir, goalX) => {
        const all = rows();
        const i = rowOf(pos);
        const x = goalX ?? pos - all[i]!.from;
        const r = all[i + dir];
        if (!r) return null;
        return { pos: Math.min(r.from + x, r.to), x };
      },
    };
    const vim = new VimCore(host);
    return { vim, type: (keys: string) => [...keys].forEach((k) => vim.key(k)), show: () => t.slice(0, sel.head) + "|" + t.slice(sel.head) };
  }

  test("j moves within a wrapped paragraph and keeps the column across short lines", () => {
    const e = wrapped("ab|cdefghijkl\nxy\nmnopq");
    e.type("j");
    expect(e.show()).toBe("abcdefg|hijkl\nxy\nmnopq");
    e.type("j");
    expect(e.show()).toBe("abcdefghijk|l\nxy\nmnopq");
    e.type("j");
    expect(e.show()).toBe("abcdefghijkl\nx|y\nmnopq"); // the line's end: not on its newline
    e.type("j");
    expect(e.show()).toBe("abcdefghijkl\nxy\nmn|opq"); // back at column 2
    e.type("k");
    expect(e.show()).toBe("abcdefghijkl\nx|y\nmnopq");
  });

  test("a count, or an operator, moves by the text's lines", () => {
    const e = wrapped("|abcdefghijkl\nxy\nmnopq");
    e.type("2j");
    expect(e.show()).toBe("abcdefghijkl\nxy\n|mnopq");
    const f = wrapped("ab|cdefghijkl\nxy\nmnopq");
    f.type("dj");
    expect(f.show()).toBe("|mnopq");
  });
});

describe("pieces the editor keeps the caret out of", () => {
  /** Like the engine: inside a list marker the caret goes to its nearer edge; [l](url) is one piece too. */
  function snapping(text: string, opts: { markers?: boolean } = { markers: true }) {
    const at = text.indexOf("|");
    let t = text.replace("|", "");
    let sel = { anchor: at, head: at };
    const markerEnd = (ls: number) => {
      const m = /^(\s*)(\d+\.|[-*+]|>)( \[[ x]\])? /.exec(t.slice(ls));
      return m ? ls + m[0].length : ls;
    };
    const lineStart = (p: number) => t.lastIndexOf("\n", p - 1) + 1;
    const snap = (p: number) => {
      const ls = lineStart(p);
      const me = markerEnd(ls);
      if (p > ls && p < me) return p - ls < me - p ? ls : me;
      const link = /\[[^\]]*\]\([^)]*\)/g;
      for (let m; (m = link.exec(t)); ) if (p > m.index && p < m.index + m[0].length) return p - m.index <= m.index + m[0].length - p ? m.index : m.index + m[0].length;
      return p;
    };
    const host: VimHost = {
      text: () => t,
      sel: () => ({ ...sel }),
      select: (anchor, head) => void (sel = { anchor: snap(anchor), head: snap(head) }),
      replace: (from, to, s) => void (t = t.slice(0, from) + s + t.slice(to)),
      undo: () => {},
      redo: () => {},
      enter: () => {},
      readOnly: () => false,
      textStart: opts.markers ? (p) => markerEnd(lineStart(p)) : undefined,
    };
    const vim = new VimCore(host);
    return { vim, type: (keys: string) => (keys.match(/<[^>]+>|[\s\S]/gu) ?? []).forEach((k) => vim.key(k) || host.replace(sel.head, sel.head, k) || void (sel = { anchor: sel.head + 1, head: sel.head + 1 })), show: () => t.slice(0, sel.head) + "|" + t.slice(sel.head) };
  }

  test("l and w go from a numbered item's number into its text, h and b come back", () => {
    const e = snapping("intro\n|1. first item");
    e.type("l");
    expect(e.show()).toBe("intro\n1. |first item");
    e.type("h");
    expect(e.show()).toBe("intro\n|1. first item");
    e.type("w");
    expect(e.show()).toBe("intro\n1. |first item");
    e.type("w");
    expect(e.show()).toBe("intro\n1. first |item");
    e.type("bb");
    expect(e.show()).toBe("intro\n|1. first item");
  });

  test("^ and I go to the item's text; task and two-digit markers too", () => {
    const e = snapping("|10. ten\n- [ ] todo");
    e.type("^");
    expect(e.show()).toBe("10. |ten\n- [ ] todo");
    e.type("j0l");
    expect(e.show()).toBe("10. ten\n- [ ] |todo");
    e.type("0IX<Esc>");
    expect(e.show()).toBe("10. ten\n- [ ] |Xtodo");
  });

  test("without textStart, l still steps over a piece instead of sticking", () => {
    const e = snapping("|1. a [link](http://x) b", { markers: false });
    e.type("l");
    expect(e.show()).toBe("1. |a [link](http://x) b");
    e.type("ll");
    expect(e.show()).toBe("1. a |[link](http://x) b");
    e.type("l");
    expect(e.show()).toBe("1. a [link](http://x)| b");
  });
});
