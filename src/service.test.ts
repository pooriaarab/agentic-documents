// Two services on one store, the way two replicas of a server share R2. Each test is a way a
// document can be lost or applied twice when two writers meet.
import { describe, expect, test } from "vitest";
import { Suggestions } from "./review.js";
import { MemoryBlobs } from "./memory-blobs.js";
import { DocsService } from "./service.js";

const bot = { kind: "agent_of_human", name: "scribe" } as const;
const ada = { kind: "human", name: "Ada" } as const;
const bob = { kind: "human", name: "Bob" } as const;

function pair() {
  const blobs = new MemoryBlobs();
  return { a: new DocsService(blobs), b: new DocsService(blobs), blobs };
}

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
