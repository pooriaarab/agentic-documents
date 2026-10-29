import { StoreConflictError, type AdapterOptions, type Doc, type Store } from "agentic-identity";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { join } from "node:path";
import { createFileBlobs } from "./file-blobs.js";

const ATTEMPTS = 64;
const META = "migrations";
const OLD_KEY = "store";

/**
 * A Store kept in one file under `dir`, from `agentic-identity/file`. Stores on the same path share
 * their data across processes (CLI runs, MCP servers). A write that loses a race with another process
 * runs again, up to ${ATTEMPTS} times, then throws StoreConflictError. The store suits a small local catalog.
 * Before version 0.9 the catalog lived in one blob under `dir`. The first write after the upgrade imports it.
 */
export function createFileStore(dir: string, options: AdapterOptions & { shared?: string } = {}): Store {
  // `shared` (used by the contract suites) names a dataset. The directory already is the dataset.
  const { shared: _shared, ...rest } = options;
  const inner = createIdentityFileStore({ ...rest, path: join(dir, "store.json") });
  const old = createFileBlobs(dir);
  let imported: Promise<void> | undefined;

  // Import the old snapshot once per instance. The marker makes it run once per directory, even with rival processes.
  const ready = (): Promise<void> => {
    imported ??= (async () => {
      const found = await old.get(OLD_KEY);
      if (!found) return;
      const rows = JSON.parse(new TextDecoder().decode(found.data)) as [string, string, Doc][];
      await retried(() =>
        inner.transaction(async (tx) => {
          if ((await tx.get(META, OLD_KEY)) !== null) return;
          const missing: typeof rows = [];
          for (const row of rows) if ((await tx.get(row[0], row[1])) === null) missing.push(row); // every read comes before a write
          for (const [collection, id, doc] of missing) await tx.put(collection, id, doc);
          await tx.put(META, OLD_KEY, { done: true });
        }),
      );
    })().catch((error) => {
      imported = undefined; // a failed import runs again on the next call, so a catalog is never read half-imported
      throw error;
    });
    return imported;
  };

  const retried = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof StoreConflictError) || attempt >= ATTEMPTS) throw error;
        await new Promise((done) => setTimeout(done, Math.min(5 * attempt, 50)));
      }
    }
  };

  return {
    region: inner.region,
    get: async (collection, id) => (await ready(), inner.get(collection, id)),
    query: async (collection, query) => (await ready(), inner.query(collection, query)),
    put: async (collection, id, doc) => (await ready(), retried(() => inner.put(collection, id, doc))),
    delete: async (collection, id) => (await ready(), retried(() => inner.delete(collection, id))),
    transaction: async (fn) => (await ready(), retried(() => inner.transaction(fn))),
  };
}
