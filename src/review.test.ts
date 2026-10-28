// Failure modes first. Each test names one way comments or suggestions can go wrong.
import { describe, expect, test } from "vitest";
import { AgenticDoc, DocError, Suggestions, Threads, type Principal } from "./index.js";

const human: Principal = { kind: "human", name: "Ada" };
const agent: Principal = { kind: "agent_of_human", name: "scribe" };
const other: Principal = { kind: "agent", name: "bot" };

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

const BASE = "Hello world\n\nHello **brave** world";
let tick = 0;
const now = () => new Date(1_800_000_000_000 + tick++ * 1000);
const fresh = (md = "Hello world") => AgenticDoc.fromMarkdown(md, human, { now });

describe("comment failures", () => {
  test("a bad target or input creates no thread", () => {
    const doc = fresh(BASE);
    const threads = new Threads(doc);
    expect(codeOf(() => threads.add({ text: "absent" }, "hi", agent))).toBe("NO_MATCH");
    expect(codeOf(() => threads.add({ text: "world" }, "hi", agent))).toBe("AMBIGUOUS_MATCH");
    expect(codeOf(() => threads.add({ text: "Hello", occurrence: 1 }, "  ", agent))).toBe("INVALID_INPUT");
    expect(codeOf(() => threads.add({ text: "Hello", occurrence: 1 }, "hi", { kind: "x", name: "y" } as never))).toBe("INVALID_AUTHOR");
    expect(threads.list()).toEqual([]);
  });

  test("a thread follows its text through concurrent edits", () => {
    const a = fresh();
    const b = a.fork();
    const id = new Threads(a).add({ text: "world" }, "why this word?", agent);
    sync(a, b);
    b.insert({ text: "world", at: "before" }, "big ", other);
    sync(a, b);
    const [thread] = new Threads(a).list();
    expect(thread).toMatchObject({ id, status: "open", stale: false, currentText: "world" });
  });

  test("a thread whose text was deleted stays, marked stale, and takes replies", () => {
    const a = fresh();
    const threads = new Threads(a);
    const id = threads.add({ text: "world" }, "check", agent);
    a.delete({ text: "world" }, human);
    threads.reply(id, "still here", human);
    const [thread] = threads.list();
    expect(thread.stale).toBe(true);
    expect(thread.messages.map((m) => m.body)).toEqual(["check", "still here"]);
  });

  test("replies from two replicas both survive a merge, with author kinds", () => {
    const a = fresh();
    const id = new Threads(a).add({ text: "world" }, "q", agent);
    const b = a.fork();
    new Threads(a).reply(id, "from a", human);
    new Threads(b).reply(id, "from b", other);
    sync(a, b);
    const messages = new Threads(a).list()[0].messages;
    expect(messages.map((m) => m.body).sort()).toEqual(["from a", "from b", "q"]);
    expect(messages.map((m) => m.author.kind).sort()).toEqual(["agent", "agent_of_human", "human"]);
    expect(new Threads(b).list()[0].messages.map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  test("resolve and reopen record who acted; unknown ids fail", () => {
    const doc = fresh();
    const threads = new Threads(doc);
    const id = threads.add({ text: "world" }, "q", agent);
    expect(codeOf(() => threads.resolve("nope", human))).toBe("NO_THREAD");
    expect(codeOf(() => threads.reply("nope", "x", human))).toBe("NO_THREAD");
    threads.resolve(id, human);
    expect(threads.list({ status: "open" })).toEqual([]);
    expect(threads.list({ status: "resolved" })[0].resolvedBy).toEqual(human);
    threads.reopen(id, other);
    expect(threads.list({ status: "open" })).toHaveLength(1);
    expect(threads.list()[0].resolvedBy).toBeUndefined();
  });

  test("threads survive a save and restore", () => {
    const doc = fresh();
    new Threads(doc).add({ text: "world" }, "q", agent);
    const copy = AgenticDoc.fromUpdate(doc.encode());
    expect(new Threads(copy).list()).toEqual(new Threads(doc).list());
  });
});

describe("suggestion failures", () => {
  test("a suggestion changes nothing until it is accepted", () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    const before = doc.toMarkdown();
    const id = suggestions.add({ text: "world" }, "moon", agent);
    expect(doc.toMarkdown()).toBe(before);
    suggestions.accept(id, human);
    expect(doc.toMarkdown().trim()).toBe("Hello moon");
  });

  test("accept logs the accepter as editor and keeps the suggester as origin", () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    suggestions.accept(suggestions.add({ text: "world" }, "moon", agent), human);
    const last = doc.edits().at(-1)!;
    expect(last).toMatchObject({ op: "replace", author: human, suggestion: { author: agent } });
    expect(suggestions.list()[0]).toMatchObject({ status: "accepted", decidedBy: human, author: agent });
  });

  test("reject leaves the text; a decided suggestion cannot be decided again", () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    const id = suggestions.add({ text: "world" }, "moon", agent);
    suggestions.reject(id, human);
    expect(doc.toMarkdown().trim()).toBe("Hello world");
    expect(codeOf(() => suggestions.accept(id, human))).toBe("ALREADY_DECIDED");
    expect(codeOf(() => suggestions.reject(id, human))).toBe("ALREADY_DECIDED");
    expect(codeOf(() => suggestions.accept("nope", human))).toBe("NO_SUGGESTION");
  });

  test("accept after the text changed is STALE_ANCHOR and stays pending", () => {
    const a = fresh();
    const b = a.fork();
    const id = new Suggestions(a).add({ text: "world" }, "moon", agent);
    sync(a, b);
    b.replace({ text: "world" }, "earth", other);
    sync(a, b);
    const suggestions = new Suggestions(a);
    expect(codeOf(() => suggestions.accept(id, human))).toBe("STALE_ANCHOR");
    expect(suggestions.list()[0]).toMatchObject({ status: "pending", stale: true });
    expect(a.toMarkdown().trim()).toBe("Hello earth");
    suggestions.reject(id, human);
    expect(suggestions.list()[0].status).toBe("rejected");
  });

  test("accepting one of two overlapping suggestions makes the other stale", () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    const first = suggestions.add({ text: "world" }, "moon", agent);
    const second = suggestions.add({ text: "world" }, "earth", other);
    suggestions.accept(first, human);
    expect(codeOf(() => suggestions.accept(second, human))).toBe("STALE_ANCHOR");
  });

  test("insert and delete suggestions apply as asked", () => {
    const doc = fresh("Hello **brave** world");
    const suggestions = new Suggestions(doc);
    suggestions.accept(suggestions.add({ text: "world", at: "after" }, "!", agent), human);
    suggestions.accept(suggestions.add({ text: "Hello " }, "", agent), human);
    expect(suggestions.list().map((s) => s.kind)).toEqual(["insert", "delete"]);
    expect(doc.toMarkdown().trim()).toBe("**brave** world!");
  });

  test("a bad target, empty insert, or bad author creates nothing", () => {
    const doc = fresh(BASE);
    const suggestions = new Suggestions(doc);
    expect(codeOf(() => suggestions.add({ text: "absent" }, "x", agent))).toBe("NO_MATCH");
    expect(codeOf(() => suggestions.add({ text: "world" }, "x", agent))).toBe("AMBIGUOUS_MATCH");
    expect(codeOf(() => suggestions.add({ text: "Hello", occurrence: 1, at: "after" }, "", agent))).toBe("INVALID_INPUT");
    expect(codeOf(() => suggestions.add({ text: "Hello", occurrence: 1 }, "x", undefined as never))).toBe("INVALID_AUTHOR");
    expect(suggestions.list()).toEqual([]);
  });

  test("an agent's suggestion reaches a person's replica and is accepted there", () => {
    const person = fresh();
    const bot = person.fork();
    const id = new Suggestions(bot).add({ text: "world" }, "moon", agent);
    sync(person, bot);
    new Suggestions(person).accept(id, human);
    sync(person, bot);
    expect(bot.toMarkdown().trim()).toBe("Hello moon");
    expect(new Suggestions(bot).list()[0]).toMatchObject({ status: "accepted", author: agent, decidedBy: human });
  });
});
