import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DocError } from "../errors.js";

/** A blob file from release 0.9 and earlier: `<dir>/<sha256(key)>`, a 4-byte length, a JSON header, then the bytes. */
const HEADER = 4;
// A move reads, writes one blob, and removes one file. It takes milliseconds, so two minutes marks a dead holder.
const STALE_MS = 120_000;
const WAIT_MS = 10_000;
const legacyPath = (dir: string, key: string) => resolve(dir, createHash("sha256").update(key).digest("hex"));
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Read an old blob. Null when there is none. A damaged file throws an error that names it, so nothing is imported half-read. */
export async function readLegacyBlob(dir: string, key: string): Promise<{ data: Uint8Array; contentType?: string } | null> {
  const path = legacyPath(dir, key);
  let file: Buffer;
  try {
    file = await readFile(path);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw new Error(`cannot read the old blob file ${path}: ${(error as Error).message}`, { cause: error });
  }
  try {
    const end = HEADER + file.readUInt32BE(0);
    const { contentType } = JSON.parse(file.subarray(HEADER, end).toString("utf8")) as { contentType?: string };
    return { data: new Uint8Array(file.subarray(end)), ...(typeof contentType === "string" ? { contentType } : {}) };
  } catch (error) {
    throw new Error(`the old blob file ${path} is damaged; remove it by hand`, { cause: error });
  }
}

export const hasLegacyBlob = (dir: string, key: string) => stat(legacyPath(dir, key)).then(() => true, (error) => (code(error) === "ENOENT" ? false : Promise.reject(error)));

export const removeLegacyBlob = (dir: string, key: string) => rm(legacyPath(dir, key), { force: true });

/** Keep an old file that lost to a newer blob. Nothing reads it again. */
export const setAsideLegacyBlob = (dir: string, key: string) => rename(legacyPath(dir, key), `${legacyPath(dir, key)}.superseded-${randomUUID()}`).catch((error) => (code(error) === "ENOENT" ? undefined : Promise.reject(error)));

/** True when the lock is gone, or was stale and is now moved away. An unreadable or future-dated lock is live. */
async function clearStale(lock: string): Promise<boolean> {
  let token: string;
  let age: number;
  try {
    token = await readFile(lock, "utf8");
    age = Date.now() - (await stat(lock)).mtimeMs;
  } catch (error) {
    if (code(error) === "ENOENT") return true;
    throw error;
  }
  if (!(age > STALE_MS)) return false; // also false for NaN
  const moved = `${lock}.stale-${randomUUID()}`;
  try {
    await rename(lock, moved); // only one taker wins this rename
  } catch (error) {
    if (code(error) === "ENOENT") return true;
    throw error;
  }
  // A fresh lock may have replaced the stale one between the read and the rename. Put it back.
  if ((await readFile(moved, "utf8").catch(() => token)) !== token) await link(moved, lock).catch(() => undefined);
  await rm(moved, { force: true });
  return true;
}

/**
 * Run `run` while this process holds the lock for one key. The move of an old blob and a delete of that key
 * both take it, so a delete cannot lose to a move that read the old file first. A stale lock is taken over.
 */
export async function withLegacyLock<T>(dir: string, key: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = `${legacyPath(dir, key)}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const file = await open(lock, "wx");
      try {
        await file.writeFile(token);
      } catch (error) {
        await rm(lock, { force: true }); // a lock with no token would block this key until it goes stale
        throw error;
      } finally {
        await file.close();
      }
      break;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      if (await clearStale(lock)) continue;
      if (Date.now() >= deadline) throw new DocError("LOCKED", "another writer holds this document; try again");
      await new Promise((done) => setTimeout(done, 5 + Math.random() * 20));
    }
  }
  try {
    return await run();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => null)) === token) await rm(lock, { force: true });
  }
}
