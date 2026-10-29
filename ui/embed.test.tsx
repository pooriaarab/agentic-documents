// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenticDoc } from "../src/doc.js";
import { schema as engineSchema } from "../src/schema.js";
import { mountEditor, type EditorClient, type MountedEditor } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout. ProseMirror asks for rectangles when it scrolls the caret into view.
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
document.elementFromPoint = () => null;

const ada = { kind: "human" as const, name: "Ada", role: "editor" as const };

function fakeClient(markdown: string | Error) {
  const saves: { id: string; markdown: string; create?: boolean }[] = [];
  const client: EditorClient = {
    state: vi.fn(async () => {
      if (markdown instanceof Error) throw markdown;
      return AgenticDoc.fromMarkdown(markdown, { kind: "human", name: "Seed" }).encode();
    }),
    checkpoint: vi.fn(async (id: string, update: Uint8Array, call?: { create?: boolean }) => {
      saves.push({ id, markdown: AgenticDoc.fromUpdate(update).toMarkdown(), create: call?.create });
      return { ok: true as const };
    }),
  };
  return { client, saves };
}

const noDocument = Object.assign(new Error("no document"), { code: "NO_DOCUMENT" });

let mounted: MountedEditor | undefined;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
  host?.remove();
});

async function mount(...args: Parameters<typeof mountEditor> extends [HTMLElement, infer O] ? [O] : never) {
  host = document.body.appendChild(document.createElement("div"));
  await act(async () => void (mounted = mountEditor(host, ...args)));
  await vi.waitFor(() => expect(host.querySelector('[role="textbox"]')).not.toBeNull());
  return host.querySelector<HTMLElement>('[role="textbox"]')!;
}

const editorOf = (box: HTMLElement) => (box as HTMLElement & { editor: Editor }).editor;

describe("mountEditor", () => {
  it("renders the stored document with a toolbar, and the text can be edited", async () => {
    const { client } = fakeClient("# Plan\n\nShip it.");
    const box = await mount({ id: "plan", client, principal: ada });
    expect(client.state).toHaveBeenCalledWith("plan");
    await vi.waitFor(() => expect(box.textContent).toContain("Ship it."));
    expect(box.querySelector("h1")?.textContent).toBe("Plan");
    expect(box.getAttribute("contenteditable")).toBe("true");
    expect(host.querySelector('[role="toolbar"]')?.getAttribute("aria-label")).toBe("Formatting");
    expect(host.textContent).toContain("Saved");
  });

  it("shows a document with an inline image and a nested task list, as the engine writes them", async () => {
    const { client } = fakeClient("Text ![pic](https://example.com/a.png) more\n\n- [ ] one\n  - [ ] nested");
    const box = await mount({ id: "plan", client, principal: ada });
    await vi.waitFor(() => expect(box.textContent).toContain("Text  more"));
    expect(box.querySelector("p img")?.getAttribute("alt")).toBe("pic");
    expect(box.querySelector('ul[data-type="taskList"] ul[data-type="taskList"]')?.textContent).toContain("nested");
  });

  it("has every node of the engine schema, inline where the engine is inline, so any stored document opens", async () => {
    const { client } = fakeClient("Hello");
    const editor = editorOf(await mount({ id: "plan", client, principal: ada }));
    for (const [name, type] of Object.entries(engineSchema.nodes)) {
      expect(editor.schema.nodes[name], name).toBeDefined();
      expect(editor.schema.nodes[name].isInline, name).toBe(type.isInline);
    }
    for (const name of Object.keys(engineSchema.marks)) expect(editor.schema.marks[name], name).toBeDefined();
    const rich = AgenticDoc.fromMarkdown("# T\n\nA ![i](https://example.com/i.png) **b** [l](https://example.com)\n\n- [x] a\n  - [ ] b\n\n| h |\n| - |\n| c |\n\n> q\n\n```\ncode\n```\n\n1. one\n2. two\n\n- plain\n\n---\n\nline one\\\nline two\n\n```js\nlet x\n```", { kind: "human", name: "Seed" });
    const used = new Set<string>();
    const walk = (node: { type: string; content?: unknown[] }) => (used.add(node.type), node.content?.forEach((child) => walk(child as typeof node)));
    walk(rich.toJSON() as never);
    // The sample holds every node of the engine, so a content rule that drifts in any of them fails the check below.
    expect([...used].sort()).toEqual(Object.keys(engineSchema.nodes).sort());
    expect(() => editor.schema.nodeFromJSON(rich.toJSON()).check()).not.toThrow();
  });

  it("saves this tab's change on unmount, and the save never makes a document", async () => {
    const { client, saves } = fakeClient("Hello");
    const box = await mount({ id: "plan", client, principal: ada });
    await act(async () => void editorOf(box).commands.insertContentAt(editorOf(box).state.doc.content.size - 1, " world"));
    const leaving = mounted!.unmount();
    mounted = undefined;
    await act(async () => leaving); // unmount settles once the save is done
    expect(saves).toEqual([{ id: "plan", markdown: "Hello world\n", create: false }]);
  });

  it("unmount rejects when the last save fails, so the host knows the change is lost", async () => {
    const { client } = fakeClient("Hello");
    client.checkpoint = vi.fn(async () => {
      throw Object.assign(new Error("refused"), { code: "FORBIDDEN" });
    });
    const box = await mount({ id: "plan", client, principal: ada });
    await act(async () => void editorOf(box).commands.insertContentAt(1, "Oh. "));
    const leaving = mounted!.unmount();
    mounted = undefined;
    await expect(leaving).rejects.toThrow("refused");
  });

  it("leaving without a change saves nothing", async () => {
    const { client } = fakeClient("Hello");
    await mount({ id: "plan", client, principal: ada });
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(client.checkpoint).not.toHaveBeenCalled();
  });

  it("a viewer, a role it does not know, or no role reads the text but cannot change it", async () => {
    for (const role of ["viewer", "owner", undefined]) {
      const { client } = fakeClient("Hello");
      const box = await mount({ id: "plan", client, principal: { kind: "human", name: "Vic", ...(role ? { role: role as "viewer" } : {}) } });
      expect(box.getAttribute("contenteditable")).toBe("false");
      expect(host.textContent).toContain("Read only.");
      expect(host.querySelector<HTMLButtonElement>('button[aria-label="Bold"]')?.disabled).toBe(true);
      await act(async () => mounted!.unmount());
      mounted = undefined;
      host.remove();
    }
  });

  it("an agent principal shows as an agent, and the text it types is marked and logged as agent work", async () => {
    const { client, saves } = fakeClient("Hello");
    const box = await mount({ id: "plan", client, principal: { kind: "agent_of_human", name: "Scribe", role: "editor" } });
    expect(host.querySelector(".agd-stack__summary")?.textContent).toBe("1 agent");
    await act(async () => void editorOf(box).commands.insertContentAt(editorOf(box).state.doc.content.size - 1, " from a bot"));
    await vi.waitFor(() => expect(box.querySelector(".agd-agent-text")?.textContent).toBe(" from a bot"));
    const leaving = mounted!.unmount();
    mounted = undefined;
    await act(async () => leaving);
    expect(saves[0].markdown).toBe("Hello from a bot\n");
  });

  it("content inserted from onEditor on a stored document is saved", async () => {
    const { client, saves } = fakeClient("Hello");
    await mount({ id: "plan", client, principal: ada, onEditor: (e) => void e?.commands.insertContentAt(e.state.doc.content.size - 1, " world") });
    const leaving = mounted!.unmount();
    mounted = undefined;
    await act(async () => leaving);
    expect(saves).toEqual([{ id: "plan", markdown: "Hello world\n", create: false }]);
  });

  it("a person's typed text is not marked as agent work", async () => {
    const { client } = fakeClient("Hello");
    const box = await mount({ id: "plan", client, principal: ada });
    await act(async () => void editorOf(box).commands.insertContentAt(1, "Hi. "));
    await new Promise((r) => setTimeout(r, 150)); // the marks are drawn after a short wait
    expect(box.querySelector(".agd-agent-text")).toBeNull();
  });

  it("a principal with no kind, an unknown kind, or no name is refused before anything loads", () => {
    const { client } = fakeClient("Hello");
    const el = document.createElement("div");
    for (const principal of [{ name: "Ada" }, { kind: "robot", name: "R" }, { kind: "human", name: " " }, null]) {
      expect(() => mountEditor(el, { id: "plan", client, principal: principal as never })).toThrow(TypeError);
    }
    expect(client.state).not.toHaveBeenCalled();
    expect(el.childElementCount).toBe(0);
  });

  it("a missing document shows an error, calls onError, and Try again loads again", async () => {
    const { client } = fakeClient(noDocument);
    const onError = vi.fn();
    host = document.body.appendChild(document.createElement("div"));
    await act(async () => void (mounted = mountEditor(host, { id: "gone", client, principal: ada, onError })));
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("does not exist"));
    expect(onError).toHaveBeenCalledWith(noDocument);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(client.state).toHaveBeenCalledTimes(2));
  });

  it("update opens another document in the same place, and a bad principal keeps the editor as it is", async () => {
    const { client } = fakeClient("First");
    const box = await mount({ id: "one", client, principal: ada });
    await vi.waitFor(() => expect(box.textContent).toContain("First"));
    expect(() => mounted!.update({ id: "two", client, principal: { name: "Ada" } as never })).toThrow(TypeError);
    expect(host.querySelector('[role="textbox"]')?.textContent).toContain("First");
    await act(async () => mounted!.update({ id: "two", client: fakeClient("Second").client, principal: ada }));
    await vi.waitFor(() => expect(host.querySelector('[role="textbox"]')?.textContent).toContain("Second"));
  });
});
