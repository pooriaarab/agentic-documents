// Contract for the Blobs port, run on every adapter. Each test is a way a store can lose data when
// two writers meet. Two instances share one backing store, so a store that guards only its own
// instance fails.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { FileBlobs } from "./blobs.js";
import { DocError } from "./errors.js";
import { MemoryBlobs } from "./memory-blobs.js";
import type { Blobs } from "./ports.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentic-blobs-"));
  dirs.push(dir);
  return dir;
};

const adapters: [string, () => { a: Blobs; b: Blobs }][] = [
  ["FileBlobs, two instances on one directory", () => ({ a: new FileBlobs(dirs[dirs.push(tmp()) - 1]), b: new FileBlobs(dirs[dirs.length - 1]) })],
  ["MemoryBlobs, one shared instance", () => { const m = new MemoryBlobs(); return { a: m, b: m }; }],
];
const bytes = (n: number) => new TextEncoder().encode(String(n));
const num = (data: Uint8Array) => Number(new TextDecoder().decode(data));

describe.each(adapters)("Blobs contract: %s", (_name, make) => {
  test("a create-only put succeeds once, and a second one leaves the first data", async () => {
    const { a, b } = make();
    expect(await a.put("k", bytes(1), { ifVersion: null })).toBe(true);
    expect(await b.put("k", bytes(2), { ifVersion: null })).toBe(false);
    expect(num((await a.get("k"))!.data)).toBe(1);
  });

  test("a put with an old version is refused, and one with the current version is kept", async () => {
    const { a, b } = make();
    await a.put("k", bytes(1));
    const first = (await a.get("k"))!;
    expect(first.version).toEqual(expect.any(String));
    expect(await b.put("k", bytes(2), { ifVersion: first.version })).toBe(true);
    expect(await a.put("k", bytes(3), { ifVersion: first.version })).toBe(false);
    const now = (await a.get("k"))!;
    expect(num(now.data)).toBe(2);
    expect(now.version).not.toBe(first.version);
  });

  test("a put for a key that is gone is refused when a version is given", async () => {
    const { a } = make();
    expect(await a.put("gone", bytes(1), { ifVersion: "no-such-version" })).toBe(false);
    expect(await a.get("gone")).toBeNull();
  });

  test("twenty creators across two instances: exactly one wins", async () => {
    const { a, b } = make();
    const wins = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).put("once", bytes(i), { ifVersion: null })));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  test("thirty read-modify-write loops across two instances lose no update", async () => {
    const { a, b } = make();
    await a.put("n", bytes(0));
    await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const store = i % 2 ? a : b;
        for (;;) {
          const found = (await store.get("n"))!;
          if (await store.put("n", bytes(num(found.data) + 1), { ifVersion: found.version })) return;
        }
      }),
    );
    expect(num((await a.get("n"))!.data)).toBe(30);
  });
});

describe("FileBlobs on disk", () => {
  test("many unconditional puts to one key in one process all finish and leave no temp file", async () => {
    const dir = tmp();
    const store = new FileBlobs(dir);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.put("same", bytes(i))));
    expect(readdirSync(dir)).toEqual(["same"]);
  });

  test("a lock from a dead writer is taken over once it is stale", async () => {
    const dir = tmp();
    const lock = join(dir, "doc.lock");
    writeFileSync(lock, "dead-writer-token");
    utimesSync(lock, new Date(1_000), new Date(1_000));
    const store = new FileBlobs(dir, { lockStaleMs: 200, lockTimeoutMs: 2_000 });
    expect(await store.put("doc", bytes(1), { ifVersion: null })).toBe(true);
    expect(readdirSync(dir)).toEqual(["doc"]);
  });

  test("a fresh lock, even with unreadable content, is live: the writer waits, then fails with LOCKED", async () => {
    const dir = tmp();
    const lock = join(dir, "doc.lock");
    writeFileSync(lock, "\u0000not a token\u0000");
    const store = new FileBlobs(dir, { lockStaleMs: 60_000, lockTimeoutMs: 300 });
    const started = Date.now();
    await expect(store.put("doc", bytes(1))).rejects.toMatchObject({ code: "LOCKED" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(await store.get("doc")).toBeNull();
  });

  test("a lock dated in the future is live, not stale", async () => {
    const dir = tmp();
    const lock = join(dir, "doc.lock");
    writeFileSync(lock, "token");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(lock, future, future);
    const store = new FileBlobs(dir, { lockStaleMs: 100, lockTimeoutMs: 300 });
    await expect(store.put("doc", bytes(1))).rejects.toBeInstanceOf(DocError);
  });

  test("a held lock is released after a put, so the next put is quick", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "sub"));
    const store = new FileBlobs(dir, { lockTimeoutMs: 300 });
    await store.put("sub/a", bytes(1));
    await store.put("sub/a", bytes(2));
    expect(readdirSync(join(dir, "sub"))).toEqual(["a"]);
  });
});
