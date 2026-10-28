import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { BlobObject, Blobs } from "./ports.js";

/** Keeps each blob as a file under one directory. A write is atomic (temp file, then rename). */
export class FileBlobs implements Blobs {
  readonly region = "any";
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid blob key "${key}"`);
    return full;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    const temp = `${full}.${process.pid}.tmp`;
    await writeFile(temp, data);
    await rename(temp, full);
  }

  async get(key: string): Promise<BlobObject | null> {
    try {
      return { data: new Uint8Array(await readFile(this.path(key))) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}
