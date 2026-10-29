import type { AdapterOptions, Store } from "agentic-identity";
import { createFileStore as createIdentityFileStore } from "agentic-identity/file";
import { join } from "node:path";

/**
 * A Store kept in one file under `dir`, from `agentic-identity/file`. Stores on the same path share
 * their data across processes (CLI runs, MCP servers). The store suits a small local catalog.
 */
export function createFileStore(dir: string, options: AdapterOptions & { shared?: string } = {}): Store {
  // `shared` (used by the contract suites) names a dataset. The directory already is the dataset.
  const { shared: _shared, ...rest } = options;
  return createIdentityFileStore({ ...rest, path: join(dir, "store.json") });
}
