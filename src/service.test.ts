// Two services on one store, the way two replicas of a server share R2. Each test is a way a
// document can be lost or applied twice when two writers meet.
import { describe, expect, test } from "vitest";
import { AgenticDoc } from "./doc.js";
import { Suggestions } from "./review.js";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import type { Doc } from "agentic-identity";
import { DocsService } from "./service.js";

const bot = { kind: "agent_of_human", name: "scribe" } as const;
const ada = { kind: "human", name: "Ada" } as const;
const bob = { kind: "human", name: "Bob" } as const;

function pair() {
  const shared = crypto.randomUUID();
  const make = () => new DocsService({ blobs: createMemoryBlobs({ shared }), store: createMemoryStore({ shared }) });
  return { a: make(), b: make() };
}

describe("catalog", () => {
  test("keeps the creator kind, so a machine-made document stays labeled", async () => {
    const { a, b } = pair();
    await a.create("doc", "# Hi", bot);
    expect(await b.info("doc")).toMatchObject({ createdBy: { kind: "agent_of_human", name: "scribe" } });
    expect(await b.info("other")).toBeNull();
  });

  test("a damaged catalog entry is an error, not a guess", async () => {
    const store = createMemoryStore();
    const service = new DocsService({ blobs: createMemoryBlobs(), store });
    for (const entry of <Doc[]>[{ x: 1 }, { createdBy: { kind: "admin", name: "x" }, createdAt: 1 }, { createdBy: { kind: "human", name: "x" }, createdAt: "now" }]) {
      await store.put("documents", "bad", entry);
      await expect(service.info("bad")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  test("a lost create race leaves the winner's catalog entry", async () => {
    const { a, b } = pair();
    await a.create("doc", "# Hi", bot);
    await expect(b.create("doc", "# Late", ada)).rejects.toMatchObject({ code: "DOCUMENT_EXISTS" });
    expect((await a.info("doc"))?.createdBy.kind).toBe("agent_of_human");
  });
});

describe("catalog as a side record", () => {
  test("a catalog failure after a save does not fail the write, so a caller never repeats it", async () => {
    const store = createMemoryStore();
    const service = new DocsService({ blobs: createMemoryBlobs(), store });
    await service.create("doc", "# Hi", bot);
    store.transaction = async () => {
      throw new Error("D1 hiccup");
    };
    await service.write("doc", (d) => d.append("Once.", bot), bot);
    expect(await service.read("doc", (d) => d.toMarkdown())).toContain("Once.");
  });

  test("a list skips a damaged entry, and a rename of an uncataloged document names the logged creator", async () => {
    const store = createMemoryStore();
    const blobs = createMemoryBlobs();
    const service = new DocsService({ blobs, store });
    await service.create("good", "# Good", bot);
    await service.create("hurt", "# Hurt", bot);
    await store.put("documents", "hurt", { createdBy: { kind: "human", name: "x" }, createdAt: 1, updatedBy: { kind: "admin", name: "x" } });
    expect((await service.list()).map((r) => r.id)).toEqual(["good"]);
    await store.delete("documents", "good");
    await service.rename("good", "Back", ada);
    expect((await service.list())[0]).toMatchObject({ id: "good", title: "Back", createdBy: { kind: "agent_of_human", name: "scribe" }, updatedBy: { kind: "human", name: "Ada" } });
  });
});

describe("concurrent writers", () => {
  test("ten creators of one id across two services: one wins, nine get DOCUMENT_EXISTS", async () => {
    const { a, b } = pair();
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).create("doc", `# From ${i}`, bot)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "DOCUMENT_EXISTS" });
    expect(await a.read("doc", (d) => d.edits().length)).toBe(1);
  });

  test("twenty appends across two services all land", async () => {
    const { a, b } = pair();
    await a.create("doc", "start", bot);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).write("doc", (d) => d.append(`line ${i}`, bot))));
    const text = await a.read("doc", (d) => d.toMarkdown());
    for (let i = 0; i < 20; i++) expect(text).toContain(`line ${i}\n`);
  });

  test("six accepts of one suggestion across two services apply it once", async () => {
    const { a, b } = pair();
    await a.create("doc", "Hello world", bot);
    const id = await a.write("doc", (d) => new Suggestions(d).add({ text: "world" }, "moon", bot));
    await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? a : b).write("doc", (d) => new Suggestions(d).accept(id, i % 3 ? ada : bob))));
    expect(await a.read("doc", (d) => d.toMarkdown())).toBe("Hello moon\n");
    expect(await a.read("doc", (d) => d.edits().filter((e) => e.suggestion).length)).toBe(1);
  });

  test("an accept and a change by another writer both survive", async () => {
    const { a, b } = pair();
    await a.create("doc", "Hello world", bot);
    const id = await a.write("doc", (d) => new Suggestions(d).add({ text: "world" }, "moon", bot));
    await Promise.all([a.write("doc", (d) => new Suggestions(d).accept(id, ada)), b.write("doc", (d) => d.append("Tail", bot))]);
    expect(await a.read("doc", (d) => d.toMarkdown())).toBe("Hello moon\n\nTail\n");
  });

  test("a change that throws saves nothing and the document stays readable", async () => {
    const { a } = pair();
    await a.create("doc", "Hello", bot);
    await expect(a.write("doc", (d) => d.replace({ text: "absent" }, "x", bot))).rejects.toMatchObject({ code: "NO_MATCH" });
    expect(await a.read("doc", (d) => d.toMarkdown())).toBe("Hello\n");
  });
});

describe("checkpoint", () => {
  // A Blobs port that loses the first `losses` conditional saves, as if another writer got there first.
  function losing(losses: number) {
    const real = createMemoryBlobs();
    let left = losses;
    let puts = 0;
    const blobs = { ...real, put: async (key: string, data: Uint8Array, options?: Parameters<typeof real.put>[2]) => (++puts, left-- > 0 ? false : real.put(key, data, options)) } as typeof real;
    return { service: new DocsService({ blobs, store: createMemoryStore() }), puts: () => puts };
  }
  const update = (text: string) => {
    const d = AgenticDoc.fromMarkdown(text, ada);
    return d.encode();
  };

  test("a lost compare-and-set loads again and merges, and the update still lands", async () => {
    const { service, puts } = losing(3);
    await service.checkpoint("doc", update("# Two\n\nSecond."), bot);
    expect(puts()).toBe(4); // three lost, then one saved
    expect(await service.read("doc", (d) => d.toMarkdown())).toContain("Second.");
  });

  test("a writer that loses every time fails with CONFLICT and stores nothing", async () => {
    const { service } = losing(1000);
    await expect(service.checkpoint("doc", update("# D\n\nText."), bot)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.read("doc", (d) => d.toMarkdown())).rejects.toMatchObject({ code: "NO_DOCUMENT" });
  });
});
