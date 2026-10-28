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

const bob: Principal = { kind: "human", name: "Bob" };
const approver: Principal = { kind: "agent_of_human", name: "approver", scopes: ["docs:accept"] };

describe("concurrent decisions", () => {
  const twoReplicas = (md = "Hello world") => {
    const a = fresh(md);
    return { a, b: a.fork() };
  };
  const converge = (...docs: AgenticDoc[]) => {
    for (const x of docs) for (const y of docs) if (x !== y) x.applyUpdate(y.encode());
  };

  test("two replicas that accept the same replace apply it once", () => {
    const { a, b } = twoReplicas();
    const id = new Suggestions(a).add({ text: "world" }, "moon", agent);
    sync(a, b);
    new Suggestions(a).accept(id, human);
    new Suggestions(b).accept(id, bob);
    converge(a, b);
    for (const doc of [a, b]) {
      expect(doc.toMarkdown().trim()).toBe("Hello moon");
      expect(doc.edits().filter((e) => e.suggestion?.id === id)).toHaveLength(1);
    }
    expect(new Suggestions(a).list()[0]).toEqual(new Suggestions(b).list()[0]);
    expect(new Suggestions(a).list()[0].status).toBe("accepted");
  });

  test("the decider on the suggestion is the author of the edit in the log", () => {
    const { a, b } = twoReplicas();
    const id = new Suggestions(a).add({ text: "world" }, "moon", agent);
    sync(a, b);
    new Suggestions(a).accept(id, human);
    new Suggestions(b).accept(id, bob);
    converge(a, b);
    const entry = a.edits().find((e) => e.suggestion?.id === id)!;
    expect(new Suggestions(a).list()[0].decidedBy).toEqual(entry.author);
  });

  test("three replicas accept an insert once, and a delete once", () => {
    const a = fresh("Hello world");
    const [b, c] = [a.fork(), a.fork()];
    const insert = new Suggestions(a).add({ text: "world", at: "after" }, "!", agent);
    const drop = new Suggestions(a).add({ text: "Hello " }, "", agent);
    converge(a, b, c);
    for (const doc of [a, b, c]) {
      new Suggestions(doc).accept(insert, human);
      new Suggestions(doc).accept(drop, human);
    }
    converge(a, b, c);
    converge(a, b, c);
    for (const doc of [a, b, c]) {
      expect(doc.toMarkdown().trim()).toBe("world!");
      expect(doc.edits().filter((e) => e.suggestion)).toHaveLength(2);
    }
  });

  test("an accept and a reject at the same moment end as accepted, text applied once", () => {
    const { a, b } = twoReplicas();
    const id = new Suggestions(a).add({ text: "world" }, "moon", agent);
    sync(a, b);
    new Suggestions(a).accept(id, human);
    new Suggestions(b).reject(id, bob);
    converge(a, b);
    for (const doc of [a, b]) {
      expect(doc.toMarkdown().trim()).toBe("Hello moon");
      expect(new Suggestions(doc).list()[0]).toMatchObject({ status: "accepted", decidedBy: human });
    }
  });

  test("an edit made after the merge is kept when the duplicate goes", () => {
    const { a, b } = twoReplicas();
    const id = new Suggestions(a).add({ text: "world" }, "moon", agent);
    sync(a, b);
    new Suggestions(a).accept(id, human);
    new Suggestions(b).accept(id, bob);
    converge(a, b);
    a.append("Tail", human);
    converge(a, b);
    expect(b.toMarkdown()).toBe("Hello moon\n\nTail\n");
  });

  test("a second accept on one replica changes nothing; a reject after an accept is refused", () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    const id = suggestions.add({ text: "world" }, "moon", agent);
    suggestions.accept(id, human);
    suggestions.accept(id, bob);
    expect(doc.toMarkdown().trim()).toBe("Hello moon");
    expect(doc.edits().filter((e) => e.suggestion)).toHaveLength(1);
    expect(suggestions.list()[0].decidedBy).toEqual(human);
    expect(codeOf(() => suggestions.reject(id, human))).toBe("ALREADY_DECIDED");
  });
});

describe("who may decide", () => {
  const pending = () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    return { doc, suggestions, id: suggestions.add({ text: "world" }, "moon", agent) };
  };

  test("an agent without the accept scope cannot accept, of any agent kind", () => {
    for (const kind of ["agent_of_human", "agent_of_agent", "agent"] as const) {
      const { doc, suggestions, id } = pending();
      expect(codeOf(() => suggestions.accept(id, { kind, name: "x" }))).toBe("FORBIDDEN");
      expect(codeOf(() => suggestions.accept(id, { kind, name: "x", scopes: ["docs:read"] }))).toBe("FORBIDDEN");
      expect(suggestions.list()[0].status).toBe("pending");
      expect(doc.toMarkdown().trim()).toBe("Hello world");
    }
  });

  test("an agent with the accept scope can accept another principal's suggestion", () => {
    const { doc, suggestions, id } = pending();
    suggestions.accept(id, approver);
    expect(doc.toMarkdown().trim()).toBe("Hello moon");
    expect(suggestions.list()[0].decidedBy).toEqual({ kind: "agent_of_human", name: "approver" });
    expect(JSON.stringify(doc.edits())).not.toContain("docs:accept");
  });

  test("nobody accepts their own suggestion, a person or a scoped agent", () => {
    const doc = fresh();
    const suggestions = new Suggestions(doc);
    const mine = suggestions.add({ text: "Hello" }, "Bye", human);
    const theirs = suggestions.add({ text: "world" }, "moon", approver);
    expect(codeOf(() => suggestions.accept(mine, human))).toBe("FORBIDDEN");
    expect(codeOf(() => suggestions.accept(theirs, approver))).toBe("FORBIDDEN");
    expect(doc.toMarkdown().trim()).toBe("Hello world");
    suggestions.accept(mine, bob);
    suggestions.accept(theirs, human);
    expect(doc.toMarkdown().trim()).toBe("Bye moon");
  });

  test("a user token can accept", () => {
    const { doc, suggestions, id } = pending();
    suggestions.accept(id, { kind: "user_token", name: "ada-cli" });
    expect(doc.toMarkdown().trim()).toBe("Hello moon");
  });

  test("the author can withdraw a suggestion, but another agent cannot reject it", () => {
    const { suggestions, id } = pending();
    expect(codeOf(() => suggestions.reject(id, other))).toBe("FORBIDDEN");
    suggestions.reject(id, agent);
    expect(suggestions.list()[0]).toMatchObject({ status: "rejected", decidedBy: agent });
  });

  test("scopes that are not a list of strings make an invalid author", () => {
    const { suggestions, id } = pending();
    for (const scopes of ["docs:accept", [1], [""], null]) {
      expect(codeOf(() => suggestions.accept(id, { ...human, name: "Eve", scopes } as never))).toBe("INVALID_AUTHOR");
    }
  });
});
