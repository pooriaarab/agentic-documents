import { createMemoryStore, StoreConflictError, type AdapterOptions, type Doc, type Store, type StoreOps } from "agentic-identity";
import { resolve } from "node:path";
import { DocError } from "../errors.js";
import { createFileBlobs, createLocker, type FileBlobsOptions } from "./file-blobs.js";

type Change = [collection: string, id: string, doc: Doc | null];
type Row = [collection: string, id: string, doc: Doc];

const KEY = "store";
const ATTEMPTS = 64;

/**
 * A Store kept in one file. The file holds every doc as one snapshot, saved through the file Blobs
 * adapter with a conditional write. Each call loads the newest snapshot, so several processes (CLI
 * runs, MCP servers) share one dataset. A transaction holds a lock file from its first read to its
 * commit, so a rival write waits and lands after it. The conditional write is a second guard: if the
 * lock was lost and the snapshot changed, the transaction runs again on the new snapshot.
 * The store re-reads and re-writes the whole snapshot on each call: it suits a small local catalog.
 */
export function createFileStore(dir: string, options: AdapterOptions & Pick<FileBlobsOptions, "lockStaleMs" | "lockTimeoutMs"> & { shared?: string } = {}): Store {
  // The dataset is the directory. `shared` (used by the contract suites) must not reach the memory store, or it would share memory instead of the file.
  const { shared: _shared, ...rest } = options;
  const memoryOptions = { region: rest.region, now: rest.now };
  const blobs = createFileBlobs(dir, options);
  const locked = createLocker(resolve(dir), options);
  const mutex = resolve(dir, "store-mutex");
  const region = createMemoryStore(memoryOptions).region;

  async function load(): Promise<{ memory: Store; rows: Map<string, Row>; version: string | undefined }> {
    const found = await blobs.get(KEY);
    const rows = new Map<string, Row>();
    const memory = createMemoryStore(memoryOptions);
    if (found) {
      for (const row of JSON.parse(new TextDecoder().decode(found.data)) as Row[]) {
        rows.set(JSON.stringify([row[0], row[1]]), row);
        await memory.put(row[0], row[1], row[2]);
      }
    }
    return { memory, rows, version: found?.version };
  }

  /** True when saved. False when another writer changed the snapshot first. */
  async function save(rows: Map<string, Row>, changes: Change[], version: string | undefined): Promise<boolean> {
    if (changes.length === 0) return true;
    for (const [collection, id, doc] of changes) {
      const key = JSON.stringify([collection, id]);
      if (doc === null) rows.delete(key);
      else rows.set(key, [collection, id, doc]);
    }
    const data = new TextEncoder().encode(JSON.stringify([...rows.values()]));
    const saved = await blobs.put(KEY, data, version === undefined ? { ifNoneMatch: "*" } : { ifMatch: version });
    return saved !== null;
  }

  const recording = (ops: StoreOps, changes: Change[]): StoreOps => ({
    ...ops,
    put: async (collection, id, doc) => {
      await ops.put(collection, id, doc);
      changes.push([collection, id, doc]);
    },
    delete: async (collection, id) => {
      await ops.delete(collection, id);
      changes.push([collection, id, null]);
    },
  });

  const transaction: Store["transaction"] = async (fn) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const done = await locked(mutex, async (held) => {
        const { memory, rows, version } = await load();
        let changes: Change[] = [];
        const result = await memory.transaction((tx) => {
          changes = []; // a rerun starts over, so only the last run's writes count
          return fn(recording(tx, changes));
        });
        if (changes.length > 0 && !(await held())) throw new DocError("LOCKED", "the lock was taken over during the transaction; try again");
        return (await save(rows, changes, version)) ? { result } : undefined;
      });
      if (done) return done.result;
    }
    throw new StoreConflictError(`transaction kept conflicting after ${ATTEMPTS} attempts`);
  };

  return {
    region,
    get: async (collection, id) => (await load()).memory.get(collection, id),
    query: async (collection, query) => (await load()).memory.query(collection, query),
    put: (collection, id, doc) =>
      transaction(async (tx) => {
        await tx.get(collection, id); // a transaction must read before it writes
        await tx.put(collection, id, doc);
      }),
    delete: (collection, id) =>
      transaction(async (tx) => {
        await tx.get(collection, id);
        await tx.delete(collection, id);
      }),
    transaction,
  };
}
