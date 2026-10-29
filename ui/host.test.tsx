// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import type { Peer, Status } from "agentic-realtime/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { AgenticDoc } from "../src/doc.js";
import { mountEditor, type EditorClient, type HostDocument, type MountedEditor } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout. ProseMirror asks for rectangles when it scrolls the caret into view.
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
document.elementFromPoint = () => null;

const ada = { kind: "human" as const, name: "Ada", role: "editor" as const };

/** A Yjs document that holds the text in the editor's field, as the host's own room would. */
const hostDoc = (markdown: string) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, AgenticDoc.fromMarkdown(markdown, { kind: "human", name: "Seed" }).encode());
  return doc;
};
const markdownOf = (doc: Y.Doc) => AgenticDoc.fromUpdate(Y.encodeStateAsUpdate(doc)).toMarkdown();

/** A client that fails the test when the editor calls it. With a host document the editor never loads or saves. */
const untouchable = (): EditorClient => ({
  state: vi.fn(async () => {
    throw new Error("the editor must not load a host document");
  }),
  checkpoint: vi.fn(async () => {
    throw new Error("the editor must not save a host document");
  }),
});

let mounted: MountedEditor | undefined;
let element: HTMLElement;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
  element?.remove();
});

async function mount(...args: Parameters<typeof mountEditor> extends [HTMLElement, infer O] ? [O] : never) {
  element = document.body.appendChild(document.createElement("div"));
  await act(async () => void (mounted = mountEditor(element, ...args)));
  await vi.waitFor(() => expect(element.querySelector('[role="textbox"]')).not.toBeNull());
  return element.querySelector<HTMLElement>('[role="textbox"]')!;
}

const editorOf = (box: HTMLElement) => (box as HTMLElement & { editor: Editor }).editor;
const typeAtEnd = (box: HTMLElement, text: string) => act(async () => void editorOf(box).commands.insertContentAt(editorOf(box).state.doc.content.size - 1, text));

/** The presence part of a room, as a SyncClient of agentic-realtime has it. */
function fakePresence(doc: Y.Doc) {
  const listeners = new Set<(peers: Peer[]) => void>();
  const presence = {
    awareness: new Awareness(doc),
    peers: [] as Peer[],
    onPeers: vi.fn((listener: (peers: Peer[]) => void) => (listeners.add(listener), () => void listeners.delete(listener))),
    disconnect: vi.fn(),
  };
  const setPeers = (peers: Peer[]) => {
    presence.peers = peers;
    for (const listener of listeners) listener(peers);
  };
  return { presence, setPeers, listeners };
}

describe("mountEditor with a host document", () => {
  it("shows the host's text and writes edits into the host's document, with no load or save", async () => {
    const doc = hostDoc("# Plan\n\nShip it.");
    const client = untouchable();
    const box = await mount({ id: "plan", client, principal: ada, host: { doc } });
    await vi.waitFor(() => expect(box.textContent).toContain("Ship it."));
    expect(box.getAttribute("contenteditable")).toBe("true");
    await typeAtEnd(box, " Today.");
    expect(markdownOf(doc)).toBe("# Plan\n\nShip it. Today.\n");
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(client.state).not.toHaveBeenCalled();
    expect(client.checkpoint).not.toHaveBeenCalled();
  });

  it("needs no client", async () => {
    const box = await mount({ id: "plan", principal: ada, host: { doc: hostDoc("Hello") } });
    await vi.waitFor(() => expect(box.textContent).toContain("Hello"));
  });

  it("follows changes that reach the host's document from elsewhere, such as its room", async () => {
    const doc = hostDoc("Hello");
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const box = await mount({ id: "plan", principal: ada, host: { doc } });
    peer.on("update", (update: Uint8Array) => Y.applyUpdate(doc, update));
    const text = peer.getXmlFragment("default").get(0) as Y.XmlElement;
    (text.get(0) as Y.XmlText).insert(5, " from the room");
    await vi.waitFor(() => expect(box.textContent).toBe("Hello from the room"));
  });

  it("leaves the host's document and presence open on unmount, and keeps no listener on them", async () => {
    const doc = hostDoc("Hello");
    const { presence, listeners } = fakePresence(doc);
    const destroyed = vi.fn();
    doc.on("destroy", destroyed);
    const box = await mount({ id: "plan", principal: ada, host: { doc, presence } });
    await typeAtEnd(box, " world");
    const before = doc.getXmlFragment("default").toJSON();
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(destroyed).not.toHaveBeenCalled();
    expect(presence.disconnect).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    expect(doc.getXmlFragment("default").toJSON()).toBe(before);
    expect(markdownOf(doc)).toBe("Hello world\n");
  });

  it("shows no save state, since the host keeps the document, and shows the offline notice from the host's status", async () => {
    const doc = hostDoc("Hello");
    const listeners = new Set<(status: Status) => void>();
    let status: Status = "connected";
    const box = await mount({ id: "plan", principal: ada, host: { doc, status: () => status, onStatus: (l) => (listeners.add(l), () => void listeners.delete(l)) } });
    await typeAtEnd(box, " world");
    const line = element.querySelector('[role="status"].muted')!;
    expect(line.textContent).not.toMatch(/Sav(ed|ing)/);
    expect(line.textContent).not.toContain("Offline");
    await act(async () => {
      status = "disconnected";
      for (const l of listeners) l(status);
    });
    expect(line.textContent).toContain("Offline");
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(listeners.size).toBe(0);
  });

  it("shows the host's peers, a machine peer as an agent", async () => {
    const doc = hostDoc("Hello");
    const { presence, setPeers } = fakePresence(doc);
    await mount({ id: "plan", principal: ada, host: { doc, presence } });
    expect(element.querySelector(".ad-stack__summary")?.textContent).toBe("1 person");
    await act(async () => setPeers([{ clientId: 7, name: "Scribe", machine: true } as Peer]));
    expect(element.querySelector(".ad-stack__summary")?.textContent).toBe("1 person, 1 agent");
  });

  it("an agent principal's edits on a host document are logged and marked as agent work", async () => {
    const doc = hostDoc("Hello");
    const box = await mount({ id: "plan", principal: { kind: "agent", name: "Scribe", role: "editor" }, host: { doc } });
    await typeAtEnd(box, " from a bot");
    await vi.waitFor(() => expect(box.querySelector(".agent-text")?.textContent).toBe(" from a bot"));
    expect(doc.getArray<{ client: number; author: { kind: string } }>("edits").toArray().at(-1)).toMatchObject({ client: doc.clientID, author: { kind: "agent" } });
  });

  it("a viewer on a host document cannot change it", async () => {
    const doc = hostDoc("Hello");
    const box = await mount({ id: "plan", principal: { kind: "human", name: "Vic", role: "viewer" }, host: { doc } });
    expect(box.getAttribute("contenteditable")).toBe("false");
    expect(element.textContent).toContain("Read only.");
  });

  it("gives the host the editor when it is ready, and null when it goes", async () => {
    const onEditor = vi.fn();
    const box = await mount({ id: "plan", principal: ada, host: { doc: hostDoc("Hello") }, onEditor });
    await vi.waitFor(() => expect(onEditor).toHaveBeenLastCalledWith(editorOf(box)));
    expect(onEditor.mock.calls.at(-1)![0].getJSON().type).toBe("doc");
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(onEditor).toHaveBeenLastCalledWith(null);
  });

  it("content an agent inserts from onEditor is logged and marked as agent work", async () => {
    const doc = hostDoc("Hello");
    const box = await mount({ id: "plan", principal: { kind: "agent", name: "Scribe", role: "editor" }, host: { doc }, onEditor: (e) => void e?.commands.insertContentAt(e.state.doc.content.size - 1, " drafted") });
    await vi.waitFor(() => expect(box.querySelector(".agent-text")?.textContent).toBe(" drafted"));
    expect(doc.getArray("edits").toArray().at(-1)).toMatchObject({ op: "live", client: doc.clientID, author: { kind: "agent", name: "Scribe" } });
  });

  it("an onStatus that returns no function still unmounts cleanly", async () => {
    const onEditor = vi.fn();
    await mount({ id: "plan", principal: ada, host: { doc: hostDoc("Hello"), onStatus: (() => true) as never }, onEditor });
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(onEditor).toHaveBeenLastCalledWith(null);
  });

  it("an agent that only reads still gets its label for content it inserts from onEditor", async () => {
    const doc = hostDoc("Hello");
    const box = await mount({ id: "plan", principal: { kind: "agent", name: "Scribe", role: "viewer" }, host: { doc }, onEditor: (e) => void e?.commands.insertContentAt(e.state.doc.content.size - 1, " note") });
    await vi.waitFor(() => expect(box.querySelector(".agent-text")?.textContent).toBe(" note"));
    expect(doc.getArray("edits").toArray().at(-1)).toMatchObject({ op: "live", author: { kind: "agent" } });
  });

  it("an onEditor that throws leaves no listener on the host's document", async () => {
    const doc = hostDoc("Hello");
    const listening = () => (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get("update")?.size ?? 0;
    const before = listening();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {}); // React reports the error it caught
    element = document.body.appendChild(document.createElement("div"));
    await act(async () => void (mounted = mountEditor(element, { id: "plan", principal: ada, host: { doc }, onEditor: (e) => { if (e) throw new Error("host bug"); } })));
    await vi.waitFor(() => expect(element.textContent).toContain("The editor stopped"));
    quiet.mockRestore();
    expect(listening()).toBe(before);
  });

  it("each onEditor hears null only for the editor it got", async () => {
    const doc = hostDoc("Hello");
    const first = vi.fn();
    const second = vi.fn();
    await mount({ id: "plan", principal: ada, host: { doc }, onEditor: first });
    await act(async () => mounted!.update({ id: "plan", principal: ada, host: { doc }, onEditor: second }));
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(first.mock.calls.map(([e]) => e === null)).toEqual([false, true]);
    expect(second).not.toHaveBeenCalled();
  });

  it("adds no inline style, so a page that forbids inline styles shows it", async () => {
    await mount({ id: "plan", principal: ada, host: { doc: hostDoc("Hello") } });
    expect(document.querySelector("style[data-tiptap-style]")).toBeNull();
  });

  it("update moves the editor to another host document", async () => {
    await mount({ id: "one", principal: ada, host: { doc: hostDoc("First") } });
    await act(async () => mounted!.update({ id: "two", principal: ada, host: { doc: hostDoc("Second") } }));
    await vi.waitFor(() => expect(element.querySelector('[role="textbox"]')?.textContent).toBe("Second"));
  });

  it("refuses a host with a room, a host with no Yjs document, and no host with no client, before anything renders", () => {
    const el = document.createElement("div");
    const doc = hostDoc("Hello");
    const bad: object[] = [
      { host: { doc }, room: { url: "wss://example.com/ws" } },
      { host: {} },
      { host: { doc: { getXmlFragment: () => null } } },
      { host: { doc, presence: { awareness: null } } },
      {},
    ];
    for (const options of bad) expect(() => mountEditor(el, { id: "plan", principal: ada, ...options } as never)).toThrow(TypeError);
    expect(el.childElementCount).toBe(0);
  });

  it("update with a bad host throws and keeps the editor as it is", async () => {
    const box = await mount({ id: "plan", principal: ada, host: { doc: hostDoc("Hello") } });
    expect(() => mounted!.update({ id: "plan", principal: ada, host: {} as HostDocument })).toThrow(TypeError);
    expect(box.textContent).toBe("Hello");
  });
});
