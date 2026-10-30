// @vitest-environment jsdom
// Failures: self decisions, missing scope, read-only writes, stale acceptance,
// external updates not rendered, and failures hidden from the reader.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { AgenticDoc, Suggestions, type Principal } from "../src/index.js";
import { ReviewPanel } from "./review.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
test("review controls deny self, unscoped, read-only and stale acceptance", async () => {
  const human = { kind: "human" as const, name: "Ada" };
  const bot = { kind: "agent" as const, name: "Bot", scopes: ["docs:accept"] };
  const doc = AgenticDoc.fromMarkdown("Hello world", human);
  const suggestions = new Suggestions(doc);
  suggestions.add({ text: "world" }, "earth", bot);
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async (principal: Principal = human, writable = true) => {
    await act(async () => root.render(<ReviewPanel doc={doc} principal={principal} writable={writable} />));
  };
  const decisions = () => [...host.querySelectorAll("button")].filter((b) => /^(Accept|Reject)$/.test(b.textContent ?? ""));
  try {
    for (const [who, write] of [[bot, true], [{ ...bot, name: "Other", scopes: [] }, true], [human, false]] as [Principal, boolean][]) {
      await render(who, write);
      expect(decisions().every((b) => b.disabled)).toBe(true);
    }
    await render();
    expect(decisions().every((b) => !b.disabled)).toBe(true);
    await act(async () => doc.delete({ text: "world" }, human));
    expect(decisions()[0].disabled).toBe(true);
    expect(decisions()[1].disabled).toBe(false);
    expect(host.textContent).toContain("Machine-made: Bot");
    await act(async () => decisions()[1].click());
    expect(suggestions.list()[0].status).toBe("rejected");
  } finally { await act(async () => root.unmount()); }
});

test("ambiguous proposal errors stay visible and create no suggestion", async () => {
  const human = { kind: "human" as const, name: "Ada" };
  const doc = AgenticDoc.fromMarkdown("Hello world world", human);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ReviewPanel doc={doc} principal={human} writable mode="suggest" />));
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "world");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("matches 2 places");
    expect(new Suggestions(doc).list()).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});
