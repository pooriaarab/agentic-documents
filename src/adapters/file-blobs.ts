import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertBlobPutOptions, assertResponseHeaders, parseRegion, type AdapterOptions, type BlobObject, type Blobs } from "agentic-identity";
import { DocError } from "../errors.js";

export interface FileBlobsOptions extends AdapterOptions {
  /** A lock older than this is taken over. Default 10 seconds. A save takes milliseconds. */
  lockStaleMs?: number;
  /** How long a writer waits for a lock before it fails with LOCKED. Default 5 seconds. */
  lockTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const HEADER = 4;

/** One file holds a length, a JSON header (the content type), then the bytes, so a rename swaps both at once. */
function pack(data: Uint8Array, contentType: string | undefined): Buffer {
  const head = Buffer.from(JSON.stringify(contentType === undefined ? {} : { contentType }));
  const length = Buffer.alloc(HEADER);
  length.writeUInt32BE(head.length);
  return Buffer.concat([length, head, data]);
}

function unpack(file: Buffer): BlobObject {
  const end = HEADER + file.readUInt32BE(0);
  const { contentType } = JSON.parse(file.subarray(HEADER, end).toString("utf8")) as { contentType?: string };
  return {
    data: new Uint8Array(file.subarray(end)),
    version: createHash("sha256").update(file).digest("hex"),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/**
 * A lock for one file path, shared by every process that uses the same directory. `run` gets a check
 * that says whether this writer still holds the lock. A stale lock is taken over.
 */
export function createLocker(root: string, options: Pick<FileBlobsOptions, "lockStaleMs" | "lockTimeoutMs"> = {}) {
  const staleMs = options.lockStaleMs ?? 10_000;
  const timeoutMs = options.lockTimeoutMs ?? 5_000;
  /** True when the lock is gone, or was stale and is now removed. An unreadable or future-dated lock is live. */
  async function clearStale(lock: string): Promise<boolean> {
    let token: string;
    let age: number;
    try {
      token = await readFile(lock, "utf8");
      age = Date.now() - (await stat(lock)).mtimeMs;
    } catch (error) {
      if (missing(error)) return true;
      throw error;
    }
    if (!(age > staleMs)) return false; // also false for NaN
    const moved = `${lock}.stale-${randomUUID()}`;
    try {
      await rename(lock, moved); // only one taker wins this rename
    } catch (error) {
      if (missing(error)) return true;
      throw error;
    }
    // A fresh lock may have replaced the stale one between the read and the rename. Put it back.
    if ((await readFile(moved, "utf8").catch(() => token)) !== token) await link(moved, lock).catch(() => undefined);
    await rm(moved, { force: true });
    return true;
  }

  async function locked<T>(full: string, run: (held: () => Promise<boolean>) => Promise<T>): Promise<T> {
    await mkdir(root, { recursive: true });
    const lock = `${full}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const file = await open(lock, "wx");
        await file.writeFile(token).finally(() => file.close());
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await clearStale(lock)) continue;
        if (Date.now() >= deadline) throw new DocError("LOCKED", "another writer holds this document; try again");
        await sleep(5 + Math.random() * 20);
      }
    }
    const held = async () => (await readFile(lock, "utf8").catch(() => null)) === token;
    try {
      return await run(held);
    } finally {
      if (await held()) await rm(lock, { force: true });
    }
  }
  return locked;
}

/**
 * Blobs kept as files under one directory. File names are key hashes, so no key leaves the folder.
 * A write takes a lock file, checks the condition again, then writes a temp file and renames it into
 * place. A reader never sees a torn file, and two processes cannot both pass the version check.
 */
export function createFileBlobs(dir: string, options: FileBlobsOptions = {}): Blobs {
  const root = resolve(dir);
  const locked = createLocker(root, options);
  const now = options.now ?? Date.now;
  const path = (key: string) => {
    if (key === "") throw new Error("blob key must not be empty");
    return resolve(root, createHash("sha256").update(key).digest("hex"));
  };

  async function read(full: string): Promise<BlobObject | null> {
    try {
      return unpack(await readFile(full));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  return {
    region: options.region === undefined ? "unknown" : parseRegion(options.region),
    async put(key, data, opts) {
      const full = path(key);
      assertBlobPutOptions(opts);
      return locked(full, async (held) => {
        if (opts?.ifNoneMatch === "*" || opts?.ifMatch !== undefined) {
          const current = await read(full);
          if (opts.ifNoneMatch === "*" ? current !== null : current?.version !== opts.ifMatch) return null;
        }
        const file = pack(data, opts?.contentType);
        const temp = `${full}.${randomUUID()}.tmp`;
        try {
          await writeFile(temp, file);
          if (!(await held())) throw new DocError("LOCKED", "the lock was taken over while writing; try again");
          await rename(temp, full);
        } finally {
          await rm(temp, { force: true });
        }
        return { version: createHash("sha256").update(file).digest("hex") };
      });
    },
    get: (key) => read(path(key)),
    async head(key) {
      const found = await read(path(key));
      return found ? { size: found.data.length, version: found.version, ...(found.contentType === undefined ? {} : { contentType: found.contentType }) } : null;
    },
    async delete(key) {
      const full = path(key);
      await locked(full, () => rm(full, { force: true }));
    },
    /** A local path with its expiry. Nothing serves or checks it: it exists so the port is whole. */
    async signedUrl(key, opts) {
      const full = path(key);
      const { method, expiresInSeconds } = opts;
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
        throw new RangeError("expiresInSeconds must be an integer from 1 to 604800");
      }
      assertResponseHeaders(opts);
      const extra = [
        opts.responseContentDisposition === undefined ? "" : `&disposition=${encodeURIComponent(opts.responseContentDisposition)}`,
        opts.responseContentType === undefined ? "" : `&type=${encodeURIComponent(opts.responseContentType)}`,
      ].join("");
      return `file://${full}?method=${method}&expires=${now() + expiresInSeconds * 1000}${extra}`;
    },
  };
}
