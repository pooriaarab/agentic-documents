// The Blobs port shape from agentic-identity (src/ports.ts), reduced to what this
// package uses. Replace this file with an import once that package is on npm.
export type Region = "eu" | "us" | "any";

export interface BlobObject {
  data: Uint8Array;
  contentType?: string;
}

export interface Blobs {
  readonly region: Region;
  put(key: string, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
