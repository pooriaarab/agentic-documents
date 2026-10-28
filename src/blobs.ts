import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { DocError } from "./errors.js";
import type { BlobObject, Blobs, PutOptions } from "./ports.js";

export interface FileBlobsOptions {
  /** A lock older than this is taken over. Default 10 seconds. A save takes milliseconds. */
  lockStaleMs?: number;
  /** How long a writer waits for a lock before it fails with LOCKED. Default 5 seconds. */
  lockTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const versionOf = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Keeps each blob as a file under one directory. A write takes a lock file (`<key>.lock`), checks
 * the version again, then writes a uniquely named temp file and renames it into place. A reader
 * never sees a torn file, and two processes cannot both pass the version check.
 */
export class FileBlobs implements Blobs {
  readonly region = "any";
  private readonly root: string;
  private readonly staleMs: number;
  private readonly timeoutMs: number;

  constructor(dir: string, options: FileBlobsOptions = {}) {
    this.root = resolve(dir);
    this.staleMs = options.lockStaleMs ?? 10_000;
    this.timeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid blob key "${key}"`);
    return full;
  }

  /** True when the lock is gone, or was stale and is now removed. An unreadable or future-dated lock is live. */
  private async clearStale(lock: string): Promise<boolean> {
    let token: string;
    let age: number;
    try {
      token = await readFile(lock, "utf8");
      age = Date.now() - (await stat(lock)).mtimeMs;
    } catch (error) {
      if (missing(error)) return true;
      throw error;
    }
    if (!(age > this.staleMs)) return false; // also false for NaN
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

  private async locked<T>(full: string, run: (held: () => Promise<boolean>) => Promise<T>): Promise<T> {
    await mkdir(dirname(full), { recursive: true });
    const lock = `${full}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        const file = await open(lock, "wx");
        await file.writeFile(token).finally(() => file.close());
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.clearStale(lock)) continue;
        if (Date.now() >= deadline) throw new DocError("LOCKED", `another writer holds "${full.slice(this.root.length + 1)}"; try again`);
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

  private async read(full: string): Promise<BlobObject | null> {
    try {
      const data = new Uint8Array(await readFile(full));
      return { data, version: versionOf(data) };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async put(key: string, data: Uint8Array, options: PutOptions = {}): Promise<boolean> {
    const full = this.path(key);
    return this.locked(full, async (held) => {
      if (options.ifVersion !== undefined) {
        const current = await this.read(full);
        if (options.ifVersion === null ? current !== null : current?.version !== options.ifVersion) return false;
      }
      const temp = `${full}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, data);
        if (!(await held())) throw new DocError("LOCKED", `the lock on "${key}" was taken over while writing; try again`);
        await rename(temp, full);
      } finally {
        await rm(temp, { force: true });
      }
      return true;
    });
  }

  get(key: string): Promise<BlobObject | null> {
    return this.read(this.path(key));
  }

  async delete(key: string): Promise<void> {
    const full = this.path(key);
    await this.locked(full, () => rm(full, { force: true }));
  }
}
