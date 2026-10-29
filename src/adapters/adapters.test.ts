// The file adapters run the shared contract suites from agentic-identity. The suites open two
// instances on one backing dataset, so a guard that only covers one instance turns them red.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, it } from "vitest";
import { createFileBlobs, createFileStore } from "./file-store.js";

/** A blob file as release 0.9 wrote it: `<sha256(key)>`, a 4-byte length, a JSON header, the bytes. */
function writeLegacy(dir: string, key: string, data: Uint8Array, contentType?: string) {
  const head = Buffer.from(JSON.stringify(contentType === undefined ? {} : { contentType }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  writeFileSync(join(dir, createHash("sha256").update(key).digest("hex")), Buffer.concat([length, head, data]));
}

const fresh = () => mkdtempSync(join(tmpdir(), "docs-fs-"));
const shared = new Map<string, string>();
// Instances that share a name share one directory, so they see one dataset.
const dirFor = (name: string | undefined) => (name === undefined ? fresh() : (shared.get(name) ?? shared.set(name, fresh()).get(name)!));

runStoreContract((options) => createFileStore(dirFor(options.shared), options));
runBlobsContract((options) => createFileBlobs(dirFor(options.shared === undefined ? undefined : `b-${options.shared}`), { ...options, urlBase: "https://blobs.test/files", urlSecret: "s".repeat(32) }));

describe("file store", () => {
  it("keeps committed writes in a new instance and drops rolled-back ones", async () => {
    const dir = fresh();
    const one = createFileStore(dir);
    await one.put("docs", "a", { v: 1 });
    await expect(
      one.transaction(async (tx) => {
        await tx.put("docs", "c", { v: 3 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const two = createFileStore(dir);
    expect(await two.get("docs", "a")).toEqual({ v: 1 });
    expect(await two.get("docs", "c")).toBeNull();
  });

  it("imports the catalog of the old release once, and keeps later changes", async () => {
    const dir = fresh();
    const rows = [["docs", "a", { v: 1 }], ["docs", "b", { v: 2 }]];
    writeLegacy(dir, "store", new TextEncoder().encode(JSON.stringify(rows)));
    const one = createFileStore(dir);
    expect(await one.get("docs", "a")).toEqual({ v: 1 });
    await one.delete("docs", "b");
    const two = createFileStore(dir);
    expect(await two.get("docs", "b")).toBeNull();
    expect(await two.get("docs", "a")).toEqual({ v: 1 });
  });
});

describe("file blobs from an older release", () => {
  it("reads a 0.9 blob, moves it once, and keeps later writes", async () => {
    const dir = fresh();
    writeLegacy(dir, "doc-1", new TextEncoder().encode("old body"), "text/plain");
    const blobs = createFileBlobs(dir);
    const found = await blobs.get("doc-1");
    expect(new TextDecoder().decode(found?.data)).toBe("old body");
    expect(found?.contentType).toBe("text/plain");
    await blobs.put("doc-1", new TextEncoder().encode("new body"));
    expect(new TextDecoder().decode((await createFileBlobs(dir).get("doc-1"))?.data)).toBe("new body");
    await blobs.delete("doc-1");
    expect(await blobs.head("doc-1")).toBeNull();
  });

  it("does not bring back a deleted old blob", async () => {
    const dir = fresh();
    writeLegacy(dir, "gone", new TextEncoder().encode("x"));
    const blobs = createFileBlobs(dir);
    await blobs.delete("gone");
    expect(await createFileBlobs(dir).get("gone")).toBeNull();
  });

  it("a delete that runs with a read never gets the old blob back", async () => {
    for (let round = 0; round < 40; round++) {
      const dir = fresh();
      writeLegacy(dir, "k", new TextEncoder().encode("x"));
      const [a, b] = [createFileBlobs(dir), createFileBlobs(dir)];
      await Promise.all([a.get("k"), b.delete("k")]);
      expect(await createFileBlobs(dir).get("k")).toBeNull();
    }
  });

  it("keeps an old file that a newer blob replaced, and a delete clears a damaged one", async () => {
    const dir = fresh();
    const blobs = createFileBlobs(dir);
    await blobs.put("k", new TextEncoder().encode("new"));
    writeLegacy(dir, "k", new TextEncoder().encode("older"));
    expect(new TextDecoder().decode((await blobs.get("k"))?.data)).toBe("new");
    writeFileSync(join(dir, createHash("sha256").update("bad").digest("hex")), "xx");
    await expect(blobs.get("bad")).rejects.toThrow(/damaged|cannot read/);
    await blobs.delete("bad");
    expect(await blobs.get("bad")).toBeNull();
  });
});
