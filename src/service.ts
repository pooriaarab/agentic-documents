import { AgenticDoc, DocError, type DocOptions, type Principal } from "./doc.js";
import type { Blobs } from "./ports.js";

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Loads and saves documents as Yjs updates in a Blobs store. The CLI, MCP server, and API share it. */
export class DocsService {
  constructor(
    private readonly blobs: Blobs,
    private readonly options: DocOptions = {},
  ) {}

  private key(id: string): string {
    if (!ID.test(id)) throw new DocError("INVALID_INPUT", `invalid document id "${id}": use 1 to 64 of a-z, 0-9, "-" and "_"`);
    return `${id}.ydoc`;
  }

  async create(id: string, markdown: string, author: Principal): Promise<void> {
    const key = this.key(id);
    if (await this.blobs.get(key)) throw new DocError("DOCUMENT_EXISTS", `document "${id}" already exists`);
    await this.blobs.put(key, AgenticDoc.fromMarkdown(markdown, author, this.options).encode());
  }

  async read<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T> {
    const found = await this.blobs.get(this.key(id));
    if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    return run(AgenticDoc.fromUpdate(found.data, this.options));
  }

  /** Run a change, then save. A save merges what another writer saved since the load. */
  async write<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T> {
    const key = this.key(id);
    const found = await this.blobs.get(key);
    if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    const doc = AgenticDoc.fromUpdate(found.data, this.options);
    const result = run(doc);
    const latest = await this.blobs.get(key);
    if (latest) doc.applyUpdate(latest.data);
    await this.blobs.put(key, doc.encode());
    return result;
  }
}
