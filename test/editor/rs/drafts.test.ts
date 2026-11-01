// Save manually (collab.ts, unsent.ts drafts): our edits stay in the browser until saved, while the others' edits keep
// arriving; save sends them as one update and asks for a commit; an unsaved draft outlives the connection (kept,
// merged back as unsaved edits next time). The Rust engine against an in-page room. Needs the wasm package.
import { installDom } from "./dom.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { RustCollab, type CollabFactory, type SocketLike } from "../../../src/client/editor-rs/collab.ts";
import { RustEditorView } from "../../../src/client/editor-rs/view.ts";
import { UnsentEdits } from "../../../src/client/editor-rs/recover.ts";
import { draftNotes, keptDraft, keepDraft, takeDraft } from "../../../src/client/editor-rs/unsent.ts";
import type { CollabEngine } from "../../../src/client/editor-rs/types.ts";
import { FakeRoom } from "../browser/room.ts";

const pkg = new URL("../../../src/client/editor-rs/pkg/", import.meta.url);
let factory: CollabFactory | null = null;
if (existsSync(new URL("editor_wasm_bg.wasm", pkg))) {
  const m = await import(new URL("editor_wasm.js", pkg).pathname);
  m.initSync({ module: readFileSync(new URL("editor_wasm_bg.wasm", pkg)) });
  factory = Object.assign((id: number, user: object) => m.Engine.collab(id, user) as CollabEngine, {
    recover: (id: number) => m.Engine.recover_unsent(id) as Uint8Array | undefined,
  });
}
const t = factory ? test : test.skip;
installDom();
localStorage.removeItem("grimoire.manualSave.v1"); // Save manually: on (the default)
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const user = { id: "a", name: "Alice", color: "#d63b3b", kind: "human" };

function room(text: string) {
  const doc = new Y.Doc();
  const ytext = doc.getText("md");
  ytext.insert(0, text);
  const aw = new Awareness(doc);
  return { doc, ytext, room: new FakeRoom(doc, aw) };
}

function open(r: ReturnType<typeof room>, path = "p.md", opts: { recover?: UnsentEdits } = {}) {
  const sockets: SocketLike[] = [];
  const conn = new RustCollab(factory!, "r", path, user, {
    ...opts,
    socket: () => {
      const s = r.room.connect();
      sockets.push(s);
      return s;
    },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  let view: RustEditorView | null = null;
  const drafts: boolean[] = [];
  conn.on("drafts", (d) => drafts.push(d));
  return {
    conn,
    sockets,
    drafts,
    mount: () => (view = new RustEditorView(host, { collab: conn })),
    type: (at: number, s: string) => {
      view!.setSel({ anchor: at, head: at });
      view!.apply(view!.engine.insert_text(s));
    },
    destroy: () => (view?.destroy(), conn.destroy(), host.remove()),
  };
}

describe("Save manually", () => {
  t("edits wait for save while the others' edits arrive; save merges them in one go", async () => {
    const r = room("one two");
    const c = open(r);
    await tick();
    const v = c.mount();
    c.type(3, " and a half");
    await tick();
    expect(r.ytext.toString()).toBe("one two"); // the room (and agents) don't have it
    expect(c.conn.unsaved).toBe(true);
    expect(c.drafts).toEqual([true]);
    // an agent writes meanwhile: it shows up here at once
    r.ytext.insert(r.ytext.length, " three");
    await tick();
    expect(v.engine.text()).toBe("one and a half two three");
    c.conn.save();
    await tick();
    expect(r.ytext.toString()).toBe("one and a half two three");
    expect(c.conn.unsaved).toBe(false);
    expect(c.drafts).toEqual([true, false]);
    // later edits wait again
    c.type(0, "zero ");
    await tick();
    expect(r.ytext.toString()).toBe("one and a half two three");
    expect(c.conn.unsaved).toBe(true);
    c.destroy();
  });

  t("a reconnect doesn't leak the draft (its step2 is held too), and save after it lands once", async () => {
    const r = room("one");
    const c = open(r);
    await tick();
    const v = c.mount();
    c.type(3, " two");
    await tick();
    const sock = c.sockets[0]!;
    (sock as { readyState: number }).readyState = 3;
    sock.onclose?.({ code: 1006, reason: "" });
    r.ytext.insert(0, "zero ");
    await tick(600);
    expect(c.conn.status).toBe("connected");
    expect(r.ytext.toString()).toBe("zero one");
    expect(v.engine.text()).toBe("zero one two");
    c.conn.save();
    await tick();
    expect(r.ytext.toString()).toBe("zero one two");
    c.destroy();
  });

  t("an unsaved draft is kept when the note closes, and comes back unsaved next time", async () => {
    const r = room("alpha beta");
    const c = open(r, "keep.md");
    await tick();
    c.mount();
    c.type(5, " gamma");
    await tick();
    c.destroy();
    expect(r.ytext.toString()).toBe("alpha beta");
    const kept = keptDraft("r", "keep.md");
    expect(kept && { base: kept.base, text: kept.text }).toEqual({ base: "alpha beta", text: "alpha gamma beta" });
    // meanwhile an agent edits elsewhere
    r.ytext.insert(r.ytext.length, "!");
    const d = open(r, "keep.md", { recover: new UnsentEdits(kept!) });
    await tick();
    const v = d.mount();
    expect(v.engine.text()).toBe("alpha gamma beta!");
    expect(r.ytext.toString()).toBe("alpha beta!"); // still a draft
    expect(d.conn.unsaved).toBe(true);
    d.conn.save();
    await tick();
    expect(r.ytext.toString()).toBe("alpha gamma beta!");
    expect(keptDraft("r", "keep.md")).toBeNull();
    d.destroy();
  });

  t("undoing back to the server's text isn't unsaved; nothing is kept for it", async () => {
    const r = room("same");
    const c = open(r, "undo.md");
    await tick();
    const v = c.mount();
    c.type(4, "x");
    v.apply(v.engine.undo());
    await tick();
    expect(c.conn.unsaved).toBe(false);
    c.destroy();
    expect(keptDraft("r", "undo.md")).toBeNull();
    keepDraft("r", "undo.md", null);
  });

  t("turning Save manually off saves what's held and sends later edits at once", async () => {
    const r = room("x");
    const c = open(r);
    await tick();
    c.mount();
    c.type(1, "y");
    await tick();
    expect(r.ytext.toString()).toBe("x");
    localStorage.setItem("grimoire.manualSave.v1", "0");
    window.dispatchEvent(new window.CustomEvent("grimoire:manualsave"));
    await tick();
    expect(r.ytext.toString()).toBe("xy");
    c.type(2, "z");
    await tick();
    expect(r.ytext.toString()).toBe("xyz");
    localStorage.removeItem("grimoire.manualSave.v1");
    c.destroy();
  });

  test("a kept draft is taken by the one tab that restores it: another finds nothing", () => {
    keepDraft("r", "two-tabs.md", { generation: "g1", base: "a", text: "ab", update: new Uint8Array([0, 0]) });
    expect(draftNotes().has("r\u0000two-tabs.md")).toBe(true);
    expect(takeDraft("r", "two-tabs.md")?.text).toBe("ab");
    expect(takeDraft("r", "two-tabs.md")).toBeNull();
    expect(draftNotes().has("r\u0000two-tabs.md")).toBe(false);
  });
});
