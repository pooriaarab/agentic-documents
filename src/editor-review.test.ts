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

test("body text includes text after hard breaks and inline images", () => {
  const doc = fresh("one  \ntwo\n\nthree");
  expect(bodyText(doc)).toBe("one\ntwo\nthree");
  const paragraph = new Y.XmlElement("paragraph");
  doc.getXmlFragment("default").push([paragraph]);
  const before = new Y.XmlText(), after = new Y.XmlText();
  before.insert(0, "before"); after.insert(0, "after");
  paragraph.push([before, new Y.XmlElement("image"), after]);
  expect(bodyText(doc)).toBe("one\ntwo\nthree\nbeforeafter");
});

test("oversized replacements are refused before a suggestion is stored", () => {
  const doc = fresh(), review = createReview(doc, person);
  expect(() => review.suggest(anchorForQuote(doc, "world")!, "x".repeat(13_000), bot)).toThrow(/too long/);
  expect(review.suggestions).toEqual([]);
  expect(bodyText(doc)).toBe("Hello world");
  review.close();
});

test.each(["**world**", "[world](https://example.com)"])("accept preserves the first replaced character's marks: %s", marked => {
  const doc = fresh(`Hello ${marked} end`), review = createReview(doc, person);
  const s = review.suggest(anchorForQuote(doc, "world")!, "moon", bot);
  review.decide(s.id, true);
  expect(AgenticDoc.fromUpdate(Y.encodeStateAsUpdate(doc)).toMarkdown().trim()).toBe(`Hello ${marked.replace("world", "moon")} end`);
  review.close();
});

test("quote matching checks every text run and can review text after a hard break", () => {
  expect(anchorForQuote(fresh("same  \nsame"), "same")).toBeNull();
  const doc = fresh("one  \ntarget"), review = createReview(doc, person);
  const anchor = anchorForQuote(doc, "target")!;
  expect(resolveAnchor(doc, anchor)).not.toBeNull();
  review.decide(review.suggest(anchor, "moon", bot).id, true);
  expect(bodyText(doc)).toBe("one\nmoon");
  review.close();
});

test("different overlapping suggestions accepted offline both remain after merge", () => {
  const a = fresh(), ra = createReview(a, person);
  const anchor = anchorForQuote(a, "world")!;
  const first = ra.suggest(anchor, "moon", bot), second = ra.suggest(anchor, "earth", bot);
  const b = copy(a), rb = createReview(b, person);
  ra.decide(first.id, true); rb.decide(second.id, true);
  sync(a, b); sync(a, b);
  expect(["Hello moonearth", "Hello earthmoon"]).toContain(bodyText(a));
  expect(bodyText(b)).toBe(bodyText(a));
  expect(ra.suggestions.map(s => s.status)).toEqual(["accepted", "accepted"]);
  expect(ra.problems()).toEqual([]);
  ra.close(); rb.close();
});
