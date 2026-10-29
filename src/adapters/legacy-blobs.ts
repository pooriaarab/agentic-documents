import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** A blob file from release 0.9 and earlier: `<dir>/<sha256(key)>`, a 4-byte length, a JSON header, then the bytes. */
const HEADER = 4;
const legacyPath = (dir: string, key: string) => resolve(dir, createHash("sha256").update(key).digest("hex"));

/** Read an old blob. Null when there is none. A damaged file throws, so nothing is imported half-read. */
export async function readLegacyBlob(dir: string, key: string): Promise<{ data: Uint8Array; contentType?: string } | null> {
  let file: Buffer;
  try {
    file = await readFile(legacyPath(dir, key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const end = HEADER + file.readUInt32BE(0);
  const { contentType } = JSON.parse(file.subarray(HEADER, end).toString("utf8")) as { contentType?: string };
  return { data: new Uint8Array(file.subarray(end)), ...(typeof contentType === "string" ? { contentType } : {}) };
}

export const removeLegacyBlob = (dir: string, key: string) => rm(legacyPath(dir, key), { force: true });
