// Agents hard-wrap their Markdown (at 80 or 120 columns, as in code), but Grim's editor shows every line of a file as
// a line of its own: a wrapped paragraph reads as ragged lines cut mid-sentence, and one paragraph per line as a wall.
// So an agent's writes are formatted before they land (shell/fs.ts sync) with Prettier and
// prettier-plugin-sentences-per-line: no hard wraps, one sentence per line ("semantic line breaks"). Markdown renders
// the same either way (a single newline inside a paragraph is a space), so nothing changes on GitHub.
//
// Only the agent's own blocks are formatted: the runs of lines between blank lines that it wrote entirely (people's
// line breaks stay, they're deliberate here). A block that doesn't start at the margin (inside a list item or an
// indented block) or isn't Markdown on its own (front matter) is left as is, and so is any block whose formatting
// would change more than spacing, escapes and list or emphasis markers.

import { diffLines } from "diff";
import type { Plugin } from "prettier";

const FENCE = /^ {0,3}(```|~~~)/;

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

type Formatter = (text: string) => Promise<string>;
let formatter: Promise<Formatter> | null = null;

/** Prettier (standalone: no file system, so it runs in Workers too), loaded on the first agent write. */
function loadFormatter(): Promise<Formatter> {
  return (formatter ??= (async () => {
    const [{ format }, sentences] = await Promise.all([import("prettier/standalone"), import("prettier-plugin-sentences-per-line")]);
    const base = sentences.printers.mdast;
    // the plugin breaks sentences everywhere, headings too ("# Why? Because" would become a heading and a paragraph)
    const plugin: Plugin = {
      parsers: sentences.parsers,
      options: sentences.options,
      printers: {
        mdast: {
          ...base,
          print(path, options, print, args) {
            if ((path.node as { type?: string }).type === "sentenceBreak" && (path.stack as unknown[]).some((n) => (n as { type?: unknown } | null)?.type === "heading")) return " ";
            return base.print(path, options, print, args);
          },
        },
      },
    };
    return (text) => format(text, { parser: "markdown", plugins: [plugin], proseWrap: "never" });
  })());
}

/** Lines of `text` (indices) that aren't in `base`: all of them for a new file. */
function addedLines(base: string | null, text: string): Set<number> {
  const out = new Set<number>();
  if (base === null) {
    text.split("\n").forEach((_, i) => out.add(i));
    return out;
  }
  let line = 0;
  for (const part of diffLines(base, text)) {
    const n = part.count ?? 0;
    if (part.removed) continue;
    if (part.added) for (let i = 0; i < n; i++) out.add(line + i);
    line += n;
  }
  return out;
}

/** The text without what formatting may change: spacing, escapes, list and emphasis markers. */
const essence = (s: string) => s.replace(/[\s\\]/g, "").replace(/[*_+-]/g, "-");

/** `text` (an agent's write over `base`) with the blocks the agent wrote formatted. */
export async function formatAgentMarkdown(base: string | null, text: string): Promise<string> {
  const added = addedLines(base, text);
  const lines = text.split("\n");
  // blocks: [from, to) runs of lines between blank lines (a code fence is one block, blank lines and all)
  const blocks: { from: number; to: number; fm: boolean }[] = [];
  let i = 0;
  if (lines[0] === "---") {
    let end = lines.findIndex((l, j) => j > 0 && (l.trim() === "---" || l.trim() === "..."));
    end = end < 0 ? lines.length : end + 1;
    blocks.push({ from: 0, to: end, fm: true });
    i = end;
  }
  while (i < lines.length) {
    if (!lines[i]!.trim()) {
      i++;
      continue;
    }
    const from = i;
    let fence: string | null = null;
    for (; i < lines.length; i++) {
      const l = lines[i]!;
      const f = FENCE.exec(l);
      if (fence !== null) {
        if (f && l.trim().startsWith(fence)) fence = null;
        continue;
      }
      if (f) {
        fence = f[1]!;
        continue;
      }
      if (!l.trim()) break;
    }
    blocks.push({ from, to: i, fm: false });
  }
  const todo = blocks.filter((b) => !b.fm && !/^\s/.test(lines[b.from]!) && lines.slice(b.from, b.to).some((_, j) => added.has(b.from + j)) && lines.slice(b.from, b.to).every((_, j) => added.has(b.from + j)));
  if (!todo.length) return text;
  const format = await loadFormatter();
  // from the last block back, so earlier blocks' line numbers still hold
  for (const b of todo.reverse()) {
    const block = lines.slice(b.from, b.to).join("\n");
    let out: string;
    try {
      out = (await format(block)).replace(/\n+$/, "");
    } catch {
      continue;
    }
    if (out === block || essence(out) !== essence(block)) continue;
    lines.splice(b.from, b.to - b.from, ...out.split("\n"));
  }
  return lines.join("\n");
}
