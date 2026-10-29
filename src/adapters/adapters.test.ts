// The file adapters run the shared contract suites from agentic-identity. The suites open two
// instances on one backing dataset, so a guard that only covers one instance turns them red.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { describe, expect, it } from "vitest";
import { createFileBlobs } from "./file-blobs.js";
import { createFileStore } from "./file-store.js";

const fresh = () => mkdtempSync(join(tmpdir(), "docs-fs-"));
const shared = new Map<string, string>();

runStoreContract((options) => {
  // Stores that share a name share one directory and one live dataset.
  const dir = options.shared === undefined ? fresh() : (shared.get(options.shared) ?? shared.set(options.shared, fresh()).get(options.shared)!);
  return createFileStore(dir, options);
});
// Blobs always share the directory, so two instances see one dataset.
runBlobsContract((options) => {
  const dir = options.shared === undefined ? fresh() : (shared.get(`b-${options.shared}`) ?? shared.set(`b-${options.shared}`, fresh()).get(`b-${options.shared}`)!);
  return createFileBlobs(dir, options);
});

describe("file store journal", () => {
  it("keeps committed writes across a restart and drops rolled-back ones", async () => {
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
});
