// Failure modes first. Each test names one way an op can go wrong.
import { describe, expect, test } from "vitest";
import { AgenticDoc, DocError, type Principal } from "./index.js";

const human: Principal = { kind: "human", name: "Ada" };
const agent: Principal = { kind: "agent_of_human", name: "scribe" };

function sync(a: AgenticDoc, b: AgenticDoc): void {
  const [ua, ub] = [a.encode(), b.encode()];
  a.applyUpdate(ub);
  b.applyUpdate(ua);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DocError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

const BASE = "Hello world\n\nHello **brave** world\n\nTail";

describe("text match failures", () => {
  test("no match throws and leaves the doc and log untouched", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    const before = [doc.toMarkdown(), doc.edits().length];
    expect(codeOf(() => doc.replace({ text: "absent" }, "x", agent))).toBe("NO_MATCH");
    expect([doc.toMarkdown(), doc.edits().length]).toEqual(before);
  });

  test("empty text is refused", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    expect(codeOf(() => doc.delete({ text: "" }, agent))).toBe("NO_MATCH");
  });

  test("two matches throw AMBIGUOUS_MATCH with the count and contexts", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    const before = doc.toMarkdown();
    try {
      doc.replace({ text: "world" }, "x", agent);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DocError);
      expect((error as DocError).code).toBe("AMBIGUOUS_MATCH");
      expect((error as DocError).matches).toHaveLength(2);
    }
    expect(doc.toMarkdown()).toBe(before);
  });

  test("occurrence picks one match; out of range is NO_MATCH", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    doc.replace({ text: "world", occurrence: 2 }, "moon", agent);
    expect(doc.toMarkdown()).toContain("Hello world\n\nHello **brave** moon");
    expect(codeOf(() => doc.replace({ text: "world", occurrence: 2 }, "x", agent))).toBe("NO_MATCH");
  });

  test("matching is exact and case sensitive", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    expect(codeOf(() => doc.replace({ text: "hello" }, "x", agent))).toBe("NO_MATCH");
  });

  test("a match cannot cross a block boundary", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    expect(codeOf(() => doc.delete({ text: "world\nHello" }, agent))).toBe("NO_MATCH");
    expect(codeOf(() => doc.delete({ text: "worldHello" }, agent))).toBe("NO_MATCH");
  });

  test("a match across marks keeps the marks that remain", () => {
    const doc = AgenticDoc.fromMarkdown("Hello **brave** world", human);
    doc.replace({ text: "lo br" }, "X", agent);
    expect(doc.toMarkdown().trim()).toBe("HelX**ave** world");
    doc.delete({ text: "X" }, agent);
    expect(doc.toMarkdown().trim()).toBe("Hel**ave** world");
  });

  test("a replacement takes the marks of the first matched character", () => {
    const doc = AgenticDoc.fromMarkdown("Hello **brave** world", human);
    doc.replace({ text: "brave" }, "bold", agent);
    expect(doc.toMarkdown().trim()).toBe("Hello **bold** world");
  });

  test("text in headings, list items and table cells matches too", () => {
    const doc = AgenticDoc.fromMarkdown("# Title\n\n- item one\n\n| a | b |\n| - | - |\n| cell | d |", human);
    doc.replace({ text: "Title" }, "Name", agent);
    doc.replace({ text: "item one" }, "item 1", agent);
    doc.replace({ text: "cell" }, "CELL", agent);
    const md = doc.toMarkdown();
    expect(md).toContain("# Name");
    expect(md).toContain("- item 1");
    expect(md).toContain("CELL");
  });
});

describe("anchors under concurrent edits", () => {
  test("an anchor follows its text when another replica edits around it", () => {
    const a = AgenticDoc.fromMarkdown("Hello world", human);
    const b = a.fork();
    const anchor = a.anchor("world");
    b.insert({ text: "world", at: "before" }, "big ", agent);
    b.insert({ text: "world", at: "after" }, "!", agent);
    sync(a, b);
    a.replace({ anchor }, "X", agent);
    expect(a.toMarkdown().trim()).toBe("Hello big X!");
  });

  test("an anchor survives a JSON round trip", () => {
    const doc = AgenticDoc.fromMarkdown("Hello world", human);
    const anchor = JSON.parse(JSON.stringify(doc.anchor("world")));
    doc.replace({ anchor }, "moon", agent);
    expect(doc.toMarkdown().trim()).toBe("Hello moon");
  });

  test("a deleted anchor is STALE_ANCHOR and nothing changes", () => {
    const a = AgenticDoc.fromMarkdown("Hello world", human);
    const b = a.fork();
    const anchor = a.anchor("world");
    b.delete({ text: "world" }, agent);
    sync(a, b);
    expect(codeOf(() => a.replace({ anchor }, "X", agent))).toBe("STALE_ANCHOR");
    expect(a.toMarkdown().trim()).toBe("Hello");
  });

  test("an edit inside the anchored text is STALE_ANCHOR", () => {
    const a = AgenticDoc.fromMarkdown("Hello world", human);
    const b = a.fork();
    const anchor = a.anchor("world");
    b.insert({ text: "wor", at: "after" }, "ZZ", agent);
    sync(a, b);
    expect(codeOf(() => a.delete({ anchor }, agent))).toBe("STALE_ANCHOR");
  });

  test("an anchor on an ambiguous text needs an occurrence", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    expect(codeOf(() => doc.anchor("world"))).toBe("AMBIGUOUS_MATCH");
    expect(doc.anchor("world", 2).text).toBe("world");
  });
});

describe("authors", () => {
  test("a missing or unknown author kind is refused before any change", () => {
    const doc = AgenticDoc.fromMarkdown(BASE, human);
    const bad = { kind: "robot", name: "x" } as unknown as Principal;
    expect(codeOf(() => doc.append("x", bad))).toBe("INVALID_AUTHOR");
    expect(codeOf(() => doc.append("x", { kind: "agent", name: "" }))).toBe("INVALID_AUTHOR");
    expect(codeOf(() => doc.append("x", undefined as unknown as Principal))).toBe("INVALID_AUTHOR");
    expect(doc.edits()).toHaveLength(1);
  });

  test("every op logs the author kind and name, never the content", () => {
    const doc = AgenticDoc.fromMarkdown("# A\n\nsecret body", human);
    doc.append("more secret", agent);
    doc.replace({ text: "secret body" }, "other", { kind: "agent", name: "bot" });
    const log = doc.edits();
    expect(log.map((e) => [e.op, e.author.kind])).toEqual([
      ["create", "human"],
      ["append", "agent_of_human"],
      ["replace", "agent"],
    ]);
    expect(JSON.stringify(log)).not.toContain("secret");
  });
});

describe("sections", () => {
  const SRC = "Intro\n\n# One\n\nbody one\n\n## One A\n\nsub\n\n# Two\n\nbody two";
  const headings = (d: AgenticDoc) => d.outline().filter((s) => s.level > 0);

  test("outline lists headings with levels and ids that survive edits", () => {
    const a = AgenticDoc.fromMarkdown(SRC, human);
    const ids = headings(a).map((s) => s.id);
    expect(headings(a).map((s) => [s.level, s.title])).toEqual([[1, "One"], [2, "One A"], [1, "Two"]]);
    expect(new Set(ids).size).toBe(3);
    const b = a.fork();
    b.insert({ section: ids[0], at: "start" }, "new first", agent);
    b.replace({ text: "Two" }, "Second", agent);
    sync(a, b);
    expect(headings(a).map((s) => s.id)).toEqual(ids);
    expect(headings(a)[2].title).toBe("Second");
  });

  test("an unknown section id is NO_SECTION", () => {
    const doc = AgenticDoc.fromMarkdown(SRC, human);
    expect(codeOf(() => doc.delete({ section: "nope" }, agent))).toBe("NO_SECTION");
    expect(codeOf(() => doc.readSection("nope"))).toBe("NO_SECTION");
  });

  test("replace swaps the body and subsections, and keeps the heading", () => {
    const doc = AgenticDoc.fromMarkdown(SRC, human);
    doc.replace({ section: headings(doc)[0].id }, "fresh", agent);
    expect(doc.toMarkdown()).toBe("Intro\n\n# One\n\nfresh\n\n# Two\n\nbody two\n");
  });

  test("delete removes the heading, body and subsections", () => {
    const doc = AgenticDoc.fromMarkdown(SRC, human);
    doc.delete({ section: headings(doc)[0].id }, agent);
    expect(doc.toMarkdown()).toBe("Intro\n\n# Two\n\nbody two\n");
  });

  test("insert at end lands after subsections; append lands last", () => {
    const doc = AgenticDoc.fromMarkdown(SRC, human);
    doc.insert({ section: headings(doc)[0].id }, "tail of one", agent);
    doc.append("- last", agent);
    expect(doc.toMarkdown()).toBe(
      "Intro\n\n# One\n\nbody one\n\n## One A\n\nsub\n\ntail of one\n\n# Two\n\nbody two\n\n- last\n",
    );
  });

  test("readSection returns the Markdown of one section", () => {
    const doc = AgenticDoc.fromMarkdown(SRC, human);
    expect(doc.readSection(headings(doc)[1].id)).toBe("## One A\n\nsub\n");
  });
});

describe("persistence and Markdown", () => {
  const RICH = [
    "# Title",
    "",
    "A *soft* **strong** ~~gone~~ `code` [link](https://example.org/x) line.",
    "",
    "![alt](https://example.org/i.png)",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "- [x] done",
    "- [ ] todo",
    "",
    "> quoted",
    "",
    "```ts",
    "const a = 1;",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "---",
    "",
  ].join("\n");

  test("Markdown round trips through the doc", () => {
    expect(AgenticDoc.fromMarkdown(RICH, human).toMarkdown()).toBe(RICH);
  });

  test("a saved update restores text, section ids and the edit log", () => {
    const doc = AgenticDoc.fromMarkdown("# A\n\nbody", human);
    doc.append("more", agent);
    const copy = AgenticDoc.fromUpdate(doc.encode());
    expect(copy.toMarkdown()).toBe(doc.toMarkdown());
    expect(copy.outline()).toEqual(doc.outline());
    expect(copy.edits()).toEqual(doc.edits());
  });
});

describe("overlapping matches", () => {
  test("a text that overlaps itself counts every start, so banana/ana is ambiguous", () => {
    const doc = AgenticDoc.fromMarkdown("banana", human);
    expect(codeOf(() => doc.replace({ text: "ana" }, "X", agent))).toBe("AMBIGUOUS_MATCH");
    expect(codeOf(() => doc.anchor("ana"))).toBe("AMBIGUOUS_MATCH");
    expect(doc.toMarkdown().trim()).toBe("banana");
  });

  test("aaa has two matches of aa, and occurrence 2 is the one at index 1", () => {
    const doc = AgenticDoc.fromMarkdown("aaa", human);
    expect(codeOf(() => doc.delete({ text: "aa" }, agent))).toBe("AMBIGUOUS_MATCH");
    doc.replace({ text: "aa", occurrence: 2 }, "X", agent);
    expect(doc.toMarkdown().trim()).toBe("aX");
  });
});

describe("Markdown that must not lose content", () => {
  test("a reference link keeps its URL", () => {
    const doc = AgenticDoc.fromMarkdown("See [the docs][d].\n\n[d]: https://example.org/docs", human);
    expect(doc.toMarkdown()).toBe("See [the docs](https://example.org/docs).\n");
  });

  test("an image reference keeps its image", () => {
    const doc = AgenticDoc.fromMarkdown("![logo][i]\n\n[i]: https://example.org/i.png", human);
    expect(doc.toMarkdown()).toBe("![logo](https://example.org/i.png)\n");
  });

  test("footnotes are refused with INVALID_INPUT, and nothing is stored", () => {
    const md = "Claim[^1].\n\n[^1]: The source.";
    expect(codeOf(() => AgenticDoc.fromMarkdown(md, human))).toBe("INVALID_INPUT");
    const doc = AgenticDoc.fromMarkdown("kept", human);
    expect(codeOf(() => doc.append(md, agent))).toBe("INVALID_INPUT");
    expect(doc.toMarkdown().trim()).toBe("kept");
    expect(doc.edits()).toHaveLength(1);
  });
});

describe("preamble", () => {
  const PRE = "Intro line\n\n- one\n\n# First\n\nBody";
  const doc = (md = PRE) => AgenticDoc.fromMarkdown(md, human);

  test("text before the first heading has a section id that does not change", () => {
    const d = doc();
    const [pre, first] = d.outline();
    expect(pre).toMatchObject({ id: "preamble", level: 0 });
    expect(first.title).toBe("First");
    d.replace({ section: first.id }, "Changed", agent);
    d.insert({ text: "Intro", at: "before" }, "More ", agent);
    expect(d.outline()[0].id).toBe("preamble");
    expect(AgenticDoc.fromUpdate(d.encode()).outline()[0].id).toBe("preamble");
  });

  test("a document that starts with a heading lists no preamble", () => {
    expect(doc("# Only\n\nBody").outline().map((s) => s.title)).toEqual(["Only"]);
  });

  test("read, replace, insert, and delete work on the preamble", () => {
    const d = doc();
    expect(d.readSection("preamble")).toBe("Intro line\n\n- one\n");
    d.insert({ section: "preamble", at: "end" }, "Added", agent);
    expect(d.toMarkdown()).toBe("Intro line\n\n- one\n\nAdded\n\n# First\n\nBody\n");
    d.replace({ section: "preamble" }, "New intro", agent);
    expect(d.toMarkdown()).toBe("New intro\n\n# First\n\nBody\n");
    d.delete({ section: "preamble" }, agent);
    expect(d.toMarkdown()).toBe("# First\n\nBody\n");
    d.insert({ section: "preamble", at: "start" }, "Back", agent);
    expect(d.toMarkdown()).toBe("Back\n\n# First\n\nBody\n");
  });

  test("a document with no heading is all preamble", () => {
    const d = doc("Just text");
    d.append("More", agent);
    expect(d.readSection("preamble")).toBe("Just text\n\nMore\n");
  });

  test("a section edit never touches the preamble", () => {
    const d = doc();
    d.delete({ section: d.outline()[1].id }, agent);
    expect(d.toMarkdown()).toBe("Intro line\n\n- one\n");
  });

  test("an unknown section id is still NO_SECTION", () => {
    expect(codeOf(() => doc().readSection("preamble2"))).toBe("NO_SECTION");
  });
});
