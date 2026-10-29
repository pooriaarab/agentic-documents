import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DocError } from "../errors.js";

/** A blob file from release 0.9 and earlier: `<dir>/<sha256(key)>`, a 4-byte length, a JSON header, then the bytes. */
const HEADER = 4;
const STALE_MS = 30_000;
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
export const setAsideLegacyBlob = (dir: string, key: string) => rename(legacyPath(dir, key), `${legacyPath(dir, key)}.superseded`).catch((error) => (code(error) === "ENOENT" ? undefined : Promise.reject(error)));

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
      await file.writeFile(token).finally(() => file.close());
      break;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_MS) await rm(lock, { force: true }); // NaN never passes, so an unreadable age counts as live
      else if (Date.now() >= deadline) throw new DocError("LOCKED", "another writer holds this document; try again");
      else await new Promise((done) => setTimeout(done, 5 + Math.random() * 20));
    }
  }
  try {
    return await run();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => null)) === token) await rm(lock, { force: true });
  }
}
