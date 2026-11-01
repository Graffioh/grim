// What the others just changed (agents through MCP or the shell, other people): their lines get a light tint for a
// few minutes, fading at the end, so the reader sees what was added or rewritten. The ranges follow later edits
// (mapPos, every patch); deletions mark the line where the text went. Drawn with the overlays (view.drawOwnCursor).

import { mapPos } from "./drop.ts";
import { lineDivs } from "./blocks.ts";
import { lineAt } from "./offsets.ts";
import type { Edit } from "./types.ts";

/** How long a line stays marked, and the fading at the end of it. */
export const RECENT_MS = 3 * 60_000;
const FADE_MS = 15_000;

export interface RecentHost {
  root: HTMLElement;
  doc: { text: string; lines: readonly { from: number; to: number }[] };
}

export class RecentEdits {
  private ranges: { from: number; to: number; until: number }[] = [];
  private marked = new Set<Element>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: RecentHost) {}

  /** A patch's edits (in order, each on the text the one before it left): ranges follow them; the others' are marked. */
  edited(edits: Edit[], theirs: boolean): void {
    if (!edits.length) return;
    for (const r of this.ranges) {
      r.from = mapPos(r.from, edits);
      r.to = Math.max(r.from, mapPos(r.to, edits));
    }
    if (!theirs) return;
    const until = Date.now() + RECENT_MS;
    edits.forEach((e, i) => {
      const rest = edits.slice(i + 1);
      const from = mapPos(e.from, rest);
      this.ranges.push({ from, to: Math.max(from, mapPos(e.from + e.insert.length, rest)), until });
    });
  }

  /** Mark the lines of the ranges still recent (after any render: line divs may be new). */
  draw(): void {
    const now = Date.now();
    this.ranges = this.ranges.filter((r) => r.until > now);
    const { root, doc } = this.host;
    const divs = lineDivs(root);
    const want = new Map<Element, boolean>();
    if (divs.length === doc.lines.length && doc.lines.length) {
      for (const r of this.ranges) {
        const first = lineAt(doc.lines, r.from);
        // (an insertion ending with a newline ends on the line before the next one)
        const last = lineAt(doc.lines, r.to > r.from ? r.to - 1 : r.from);
        const fading = r.until - now < FADE_MS;
        for (let i = first; i <= last; i++) {
          const el = divs[i];
          if (el) want.set(el, (want.get(el) ?? true) && fading);
        }
      }
    }
    for (const el of this.marked) if (!want.has(el)) el.classList.remove("mde-recent", "mde-recent-fading");
    for (const [el, fading] of want) {
      el.classList.add("mde-recent");
      el.classList.toggle("mde-recent-fading", fading);
    }
    this.marked = new Set(want.keys());
    this.schedule(now);
  }

  /** Draw again when the next range starts fading or ends. */
  private schedule(now: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let next = Infinity;
    for (const r of this.ranges) next = Math.min(next, r.until - now > FADE_MS ? r.until - FADE_MS : r.until);
    if (next !== Infinity) this.timer = setTimeout(() => this.draw(), Math.max(50, next - now));
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
