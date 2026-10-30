// @vitest-environment jsdom
// Failure cases: ambiguous quotes, detached ranges, concurrent edits and decisions,
// stale text, self decisions (including changed kinds), and empty/nested blocks.
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { textOf } from "agentic-comments";
import { AgenticDoc } from "./doc.js";
import { anchorOf, anchorForQuote, bodyText, createReview, resolveAnchor, stamp } from "./editor-review.js";

const person = stamp({ kind: "human", name: "Ada" });
const bot = stamp({ kind: "agent", name: "Writer", scopes: ["comments:accept"] });
const fresh = (md = "Hello **world**") => AgenticDoc.fromMarkdown(md, { kind: "human", name: "Seed" }).ydoc;
const copy = (doc: Y.Doc) => { const out = new Y.Doc(); Y.applyUpdate(out, Y.encodeStateAsUpdate(doc)); return out; };
const sync = (a: Y.Doc, b: Y.Doc) => { const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b); Y.applyUpdate(a, ub); Y.applyUpdate(b, ua); };

test("body text keeps block order and empty blocks without markup", () => {
  const doc = fresh("# Title\n\n- **One**\n- Two\n\n```\ncode\n```");
  doc.getXmlFragment("default").push([new Y.XmlElement("paragraph")]);
  expect(bodyText(doc)).toBe("Title\nOne\nTwo\ncode\n");
  expect(bodyText(new Y.Doc())).toBe("");
});

test("quotes must occur once, within one block", () => {
  expect(anchorForQuote(fresh("same\n\nsame"), "same")).toBeNull();
  expect(anchorForQuote(fresh("aaa"), "aa")).toBeNull();
  expect(anchorForQuote(fresh(), "")).toBeNull();
  expect(anchorForQuote(fresh(), "absent")).toBeNull();
  expect(anchorForQuote(fresh("Hello\n\nworld"), "Hello\nworld")).toBeNull();
});

test("anchors follow concurrent insertions and disappear with their block", () => {
  const a = fresh(), b = copy(a);
  const anchor = anchorForQuote(a, "world")!;
  resolveAnchor(a, anchor)!.text.insert(0, "A ");
  resolveAnchor(b, anchor)!.text.insert(0, "B ");
  sync(a, b);
  for (const doc of [a, b]) {
    const at = resolveAnchor(doc, anchor)!;
    expect(textOf(at.text).slice(at.from, at.to)).toBe("world");
  }
  a.getXmlFragment("default").delete(0, 1);
  expect(resolveAnchor(a, anchor)).toBeNull();
});

test("controller comments, replies, resolves, accepts and rejects in the same document", () => {
  const doc = fresh(), review = createReview(doc, person);
  const anchor = anchorForQuote(doc, "world")!;
  const thread = review.comment(anchor, "Check this");
  review.reply(thread.id, "Done");
  review.setResolved(thread.id, true);
  expect(review.threads[0].status).toBe("resolved");
  review.setResolved(thread.id, false);
  const rejected = review.suggest(anchor, "earth", bot);
  review.decide(rejected.id, false);
  expect(bodyText(doc)).toBe("Hello world");
  const accepted = review.suggest(anchor, "moon", bot);
  review.decide(accepted.id, true);
  expect(bodyText(doc)).toBe("Hello moon");
  expect(review.suggestions.map(s => s.status).sort()).toEqual(["accepted", "rejected"]);
  review.close();
});

test("stale acceptance leaves text and decision unchanged", () => {
  const doc = fresh(), review = createReview(doc, person);
  const anchor = anchorForQuote(doc, "world")!;
  const s = review.suggest(anchor, "moon", bot);
  resolveAnchor(doc, anchor)!.text.insert(7, "x");
  expect(() => review.decide(s.id, true)).toThrow();
  expect(review.suggestions[0].status).toBe("pending");
  expect(bodyText(doc)).toBe("Hello wxorld");
  review.close();
});

test("agents never decide their own work, even under another kind; scope is required", () => {
  for (const accept of [true, false]) for (const kind of ["agent", "agent_of_human", "agent_of_agent", "user_token", "human"] as const) {
    const doc = fresh(), review = createReview(doc, stamp({ kind, name: bot.name, scopes: ["comments:accept"] }));
    const s = review.suggest(anchorForQuote(doc, "world")!, "moon", bot);
    expect(() => review.decide(s.id, accept)).toThrow(/cannot decide/);
    expect(review.suggestions[0].status).toBe("pending");
    review.close();
  }
  const doc = fresh(), review = createReview(doc, stamp({ kind: "agent", name: "Other" }));
  const s = review.suggest(anchorForQuote(doc, "world")!, "moon", bot);
  expect(() => review.decide(s.id, true)).toThrow();
  review.close();
});

test.each(["moon", ""])("concurrent accepts apply replacement %j once", replacement => {
  const a = fresh(), ra = createReview(a, person);
  const s = ra.suggest(anchorForQuote(a, "world")!, replacement, bot);
  const b = copy(a), rb = createReview(b, person);
  ra.decide(s.id, true); rb.decide(s.id, true);
  sync(a, b); sync(a, b);
  expect(bodyText(a)).toBe(`Hello ${replacement}`);
  expect(bodyText(b)).toBe(bodyText(a));
  expect(ra.problems()).toEqual([]); expect(rb.problems()).toEqual([]);
  ra.close(); rb.close();
});


test("selection anchors refuse empty, cross-block, inline breaks and mismatched documents", () => {
  const doc = fresh("Hello **world**\n\nSecond");
  const editor = new Editor({ extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: doc })] });
  expect(anchorOf(editor, doc)).toHaveProperty("problem");
  editor.commands.setTextSelection({ from: 7, to: 12 });
  const result = anchorOf(editor, doc);
  expect(result).toMatchObject({ quote: "world", anchor: { text: "world" } });
  editor.commands.setTextSelection({ from: 2, to: 16 });
  expect(anchorOf(editor, doc)).toHaveProperty("problem");
  editor.commands.setTextSelection({ from: 7, to: 12 });
  expect(anchorOf(editor, fresh("different"))).toHaveProperty("problem");
  editor.commands.insertContentAt(8, { type: "hardBreak" });
  editor.commands.setTextSelection({ from: 7, to: 10 });
  expect(anchorOf(editor, doc)).toHaveProperty("problem");
  editor.destroy();
});
