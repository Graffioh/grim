// Agents hard-wrap their Markdown (at 80 or 120 columns, as in code), but Grim's editor shows every line of the file
// as a line of its own: a wrapped paragraph reads as ragged lines cut mid-sentence. So an agent's writes are unwrapped
// before they land (shell/fs.ts sync): a line that continues the paragraph or list item above it is joined onto it.
// Markdown renders both the same (a single newline inside a paragraph is a space), so nothing changes on GitHub.
//
// Conservative: only lines the agent itself added are touched (people's own line breaks stay, they're deliberate
// here), only after a line long enough to have been wrapped, never in code fences, front matter, tables, HTML, or
// across a hard break (two trailing spaces, a backslash), a blank line, or the start of another block.

import { diffLines } from "diff";

/** A line shorter than this wasn't wrapped by a tool: the next line starts a line of its own on purpose. */
const WRAPPED_MIN = 60;

/** A line that starts a block of its own (heading, list item, quote, table, fence, HTML, rule). */
const BLOCK_START = /^(#{1,6}(\s|$)|[-*+]\s|\d{1,9}[.)]\s|>|\||```|~~~|<|(-[ \t]*){3,}$|(\*[ \t]*){3,}$|(_[ \t]*){3,}$|\[[^\]]+\]:\s)/;
const FENCE = /^ {0,3}(```|~~~)/;
const hardBreak = (line: string) => / {2,}$/.test(line) || /\\$/.test(line);

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
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

/** `text` (an agent's write over `base`) with the hard-wrapped lines it added joined back into their paragraphs. */
export function unwrapAgentText(base: string | null, text: string): string {
  if (!text.includes("\n")) return text;
  const added = addedLines(base, text);
  const lines = text.split("\n");
  const out: string[] = [];
  /** Whether out's last line is prose that a continuation may join (and was added by the agent). */
  let joinable = false;
  let fence: string | null = null;
  let frontMatter = lines[0] === "---";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (frontMatter) {
      out.push(line);
      if (i > 0 && (trimmed === "---" || trimmed === "...")) frontMatter = false;
      joinable = false;
      continue;
    }
    const f = FENCE.exec(line);
    if (fence !== null) {
      out.push(line);
      if (f && line.trim().startsWith(fence)) fence = null;
      joinable = false;
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(line);
      joinable = false;
      continue;
    }
    const mine = added.has(i);
    if (joinable && mine && trimmed && !BLOCK_START.test(trimmed)) {
      out[out.length - 1] = `${out[out.length - 1]!.replace(/[ \t]+$/, "")} ${trimmed}`;
      // (the joined line is long: the next continuation joins too, unless this one ends in a hard break)
      joinable = !hardBreak(line);
      continue;
    }
    out.push(line);
    const prose = trimmed !== "" && !/^(#{1,6}(\s|$)|\||<|(-[ \t]*){3,}$|(\*[ \t]*){3,}$|(_[ \t]*){3,}$|\[[^\]]+\]:\s)/.test(trimmed);
    // an indented code block (4 spaces after a blank line) isn't prose either
    const code = /^( {4}|\t)/.test(line) && (i === 0 || lines[i - 1]!.trim() === "") && !BLOCK_START.test(trimmed);
    joinable = mine && prose && !code && !hardBreak(line) && trimmed.length >= WRAPPED_MIN;
  }
  return out.join("\n");
}
