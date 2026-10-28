import type { BlobObject, Blobs, PutOptions } from "./ports.js";

/** Keeps bytes in a Map. Data lasts as long as the process or the Worker isolate. */
export class MemoryBlobs implements Blobs {
  readonly region = "any";
  private readonly items = new Map<string, { data: Uint8Array; version: string }>();
  private counter = 0;

  async put(key: string, data: Uint8Array, options: PutOptions = {}): Promise<boolean> {
    const current = this.items.get(key);
    if (options.ifVersion !== undefined && (options.ifVersion === null ? current !== undefined : current?.version !== options.ifVersion)) return false;
    this.items.set(key, { data: data.slice(), version: String(++this.counter) });
    return true;
  }

  async get(key: string): Promise<BlobObject | null> {
    const item = this.items.get(key);
    return item ? { data: item.data.slice(), version: item.version } : null;
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }
}
