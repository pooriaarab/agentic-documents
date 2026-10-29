// The file adapters run the shared contract suites from agentic-identity. The suites open two
// instances on one backing dataset, so a guard that only covers one instance turns them red.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, it } from "vitest";
import { createFileBlobs, createFileStore } from "./file-store.js";

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
    await createFileBlobs(dir).put("store", new TextEncoder().encode(JSON.stringify(rows)));
    const one = createFileStore(dir);
    expect(await one.get("docs", "a")).toEqual({ v: 1 });
    await one.delete("docs", "b");
    const two = createFileStore(dir);
    expect(await two.get("docs", "b")).toBeNull();
    expect(await two.get("docs", "a")).toEqual({ v: 1 });
  });
});
