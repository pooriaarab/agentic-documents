import { AgenticDoc, DocError, type DocOptions, type Principal } from "./doc.js";
import type { Blobs, Store } from "agentic-identity";

const ATTEMPTS = 64;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const CATALOG = "documents";

/** What the catalog keeps for each document. The author kind stays, so machine-made work stays labeled. */
export interface DocInfo {
  createdBy: { kind: string; name: string };
  createdAt: number;
}

export interface DocsPorts {
  /** Holds each document as a Yjs update. Saves are conditional on the version that was read. */
  blobs: Blobs;
  /** Holds the catalog: who created each document, and when. */
  store: Store;
}

/** Loads and saves documents as Yjs updates in a Blobs port. The CLI, MCP server, and API share it. */
export class DocsService {
  private readonly blobs: Blobs;
  private readonly store: Store;

  constructor(
    ports: DocsPorts,
    private readonly options: DocOptions = {},
  ) {
    this.blobs = ports.blobs;
    this.store = ports.store;
  }

  private key(id: string): string {
    if (!ID.test(id)) throw new DocError("INVALID_INPUT", `invalid document id "${id}": use 1 to 64 of a-z, 0-9, "-" and "_"`);
    return `${id}.ydoc`;
  }

  async create(id: string, markdown: string, author: Principal): Promise<void> {
    const key = this.key(id);
    const created = await this.blobs.put(key, AgenticDoc.fromMarkdown(markdown, author, this.options).encode(), { ifNoneMatch: "*" });
    if (!created) throw new DocError("DOCUMENT_EXISTS", `document "${id}" already exists`);
    // The blob is the document. The catalog entry follows it, and a repeat leaves the first entry alone.
    await this.store.transaction(async (tx) => {
      if ((await tx.get(CATALOG, id)) === null) await tx.put(CATALOG, id, { createdBy: { kind: author.kind, name: author.name }, createdAt: Date.now() });
    });
  }

  /** Who created the document and when, or null for a document made before the catalog existed. */
  async info(id: string): Promise<DocInfo | null> {
    this.key(id);
    return (await this.store.get(CATALOG, id)) as DocInfo | null;
  }

  async read<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T> {
    const found = await this.blobs.get(this.key(id));
    if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    return run(AgenticDoc.fromUpdate(found.data, this.options));
  }

  /**
   * Load, run the change, and save only if nobody saved in between. When someone did, load again and
   * run the change again, so a check such as "is it still pending" sees the new state.
   */
  async write<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T> {
    const key = this.key(id);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const found = await this.blobs.get(key);
      if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
      const doc = AgenticDoc.fromUpdate(found.data, this.options);
      const result = run(doc);
      if (await this.blobs.put(key, doc.encode(), { ifMatch: found.version })) return result;
    }
    throw new DocError("CONFLICT", `document "${id}" kept changing; try again`);
  }
}
