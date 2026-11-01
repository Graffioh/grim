// Edits of a session whose engine crashed, kept per user and note in this tab's sessionStorage until the next load
// merges them (recover.ts): the Yjs update from Engine.recover_unsent (every local edit of the session), the room
// generation it was made in, the text the session started from (synced, before it changed anything) and the
// editor's text at the crash. Same generation: the update merges as is (what the server already has is skipped);
// otherwise (the room was recreated from Git: other item ids) a 3-way text merge of base → text onto the server's.

export interface KeptEdits {
  /** The room generation (hello) the edits were made in; null if unknown. */
  generation: string | null;
  /** The note's text when the session synced, before its own edits. */
  base: string;
  /** The editor's text at the crash. */
  text: string;
  /** Engine.recover_unsent: the session's edits as a Yjs update. */
  update: Uint8Array;
  /** Texts of earlier crashed sessions that couldn't be merged (still offered to copy). */
  older?: string[];
}

const PREFIX = "grimoire.unsent:";
const key = (user: string, repo: string, path: string) => `${PREFIX}${user}\u0000${repo}\u0000${path}`;

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Keep a crashed session's edits for this note (this tab only). False if they couldn't be stored (quota). */
export function keepUnsent(user: string, repo: string, path: string, kept: KeptEdits): boolean {
  try {
    sessionStorage.setItem(key(user, repo, path), JSON.stringify({ v: 2, generation: kept.generation, base: kept.base, text: kept.text, update: toB64(kept.update), older: kept.older?.length ? kept.older : undefined }));
    return true;
  } catch {
    return false;
  }
}

/** The edits kept for this note, if any. */
export function keptUnsent(user: string, repo: string, path: string): KeptEdits | null {
  try {
    const raw = sessionStorage.getItem(key(user, repo, path));
    if (!raw) return null;
    const o = JSON.parse(raw) as { v?: number; generation?: unknown; base?: unknown; text?: unknown; update?: unknown; older?: unknown };
    if (o.v !== 2 || typeof o.base !== "string" || typeof o.text !== "string" || typeof o.update !== "string") return null;
    return {
      generation: typeof o.generation === "string" ? o.generation : null,
      base: o.base,
      text: o.text,
      update: Uint8Array.from(atob(o.update), (c) => c.charCodeAt(0)),
      ...(Array.isArray(o.older) && o.older.length ? { older: o.older.filter((t): t is string => typeof t === "string") } : {}),
    };
  } catch {
    return null;
  }
}

export function forgetUnsent(user: string, repo: string, path: string): void {
  try {
    sessionStorage.removeItem(key(user, repo, path));
  } catch {}
}

/** Drop every note's kept edits of `user` (signing out), and entries from before they were kept per user. */
export function forgetAllUnsent(user: string): void {
  try {
    const mine = `${PREFIX}${user}\u0000`;
    const drop: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX) && (k.startsWith(mine) || k.split("\u0000").length === 2)) drop.push(k);
    }
    for (const k of drop) sessionStorage.removeItem(k);
  } catch {}
}

// Drafts: with "Save manually" (the account menu; on by default) a note's edits stay in this browser until saved
// (collab.ts holds them back). A draft that is still unsaved when its note closes (another note opened, the tab
// closed, the room reset) is kept here in localStorage, in the same shape as a crashed session's edits, and merged
// back as unsaved edits the next time the note opens (the same recover.ts path).

const DRAFT_PREFIX = "grimoire.draft:";
const draftKey = (repo: string, path: string) => `${DRAFT_PREFIX}${repo}\u0000${path}`;
export const MANUAL_SAVE_KEY = "grimoire.manualSave.v1";
export const MANUAL_SAVE_EVENT = "grimoire:manualsave";
/** Dispatched on window when a note's unsaved state may have changed (the sidebar's marks follow). */
export const DRAFTS_EVENT = "grimoire:drafts";

export function draftsChanged(): void {
  window.dispatchEvent(new window.CustomEvent(DRAFTS_EVENT));
}

/** Edits wait for Save (⌘S, :w): on unless turned off. */
export function manualSave(): boolean {
  try {
    return localStorage.getItem(MANUAL_SAVE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setManualSave(on: boolean): void {
  try {
    if (on) localStorage.removeItem(MANUAL_SAVE_KEY);
    else localStorage.setItem(MANUAL_SAVE_KEY, "0");
  } catch {}
  window.dispatchEvent(new window.CustomEvent(MANUAL_SAVE_EVENT, { detail: on }));
}

/** Keep (or with null, forget) a note's unsaved draft. False if it couldn't be stored. */
export function keepDraft(repo: string, path: string, kept: KeptEdits | null): boolean {
  try {
    if (!kept) {
      localStorage.removeItem(draftKey(repo, path));
    } else {
      localStorage.setItem(draftKey(repo, path), JSON.stringify({ v: 2, generation: kept.generation, base: kept.base, text: kept.text, update: toB64(kept.update) }));
    }
    return true;
  } catch {
    return false;
  } finally {
    draftsChanged();
  }
}

/**
 * A note's kept draft, taken out of storage: the tab that restores it is its only holder from then on (another tab
 * opening the note must not restore it too, or both would save it: the text twice). Put it back (keepDraft) if it
 * can't be restored after all.
 */
export function takeDraft(repo: string, path: string): KeptEdits | null {
  const kept = keptDraft(repo, path);
  if (kept) keepDraft(repo, path, null);
  return kept;
}

/** The notes with a kept draft, as `repo\0path` keys. */
export function draftNotes(): Set<string> {
  const out = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(DRAFT_PREFIX)) out.add(k.slice(DRAFT_PREFIX.length));
    }
  } catch {}
  return out;
}

export function keptDraft(repo: string, path: string): KeptEdits | null {
  try {
    const raw = localStorage.getItem(draftKey(repo, path));
    if (!raw) return null;
    const o = JSON.parse(raw) as { v?: number; generation?: unknown; base?: unknown; text?: unknown; update?: unknown };
    if (o.v !== 2 || typeof o.base !== "string" || typeof o.text !== "string" || typeof o.update !== "string") return null;
    return { generation: typeof o.generation === "string" ? o.generation : null, base: o.base, text: o.text, update: Uint8Array.from(atob(o.update), (c) => c.charCodeAt(0)) };
  } catch {
    return null;
  }
}
