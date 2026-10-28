// The Blobs port shape from agentic-identity (src/ports.ts), reduced to what this
// package uses. Replace this file with an import once that package is on npm.
export type Region = "eu" | "us" | "any";

export interface BlobObject {
  data: Uint8Array;
  contentType?: string;
  /** Changes whenever the data changes. Pass it back as `ifVersion` (an ETag on R2). */
  version: string;
}

export interface PutOptions {
  contentType?: string;
  /**
   * Write only if the stored version matches. `null` means only if the key is absent. A refused
   * write returns `false` and changes nothing. Leave it out to overwrite.
   */
  ifVersion?: string | null;
}

export interface Blobs {
  readonly region: Region;
  /** Returns `false` when `ifVersion` did not match. */
  put(key: string, data: Uint8Array, options?: PutOptions): Promise<boolean>;
  get(key: string): Promise<BlobObject | null>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
