import * as Y from "yjs";
import { AgenticDoc, DocError, PRINCIPAL_KINDS, type DocOptions, type Principal, type PrincipalKind } from "./doc.js";
import type { Blobs, PrincipalContext, Store } from "agentic-identity";
import { isPerson, Suggestions, Threads } from "./review.js";
import { contextOf, StoreSharing, type DocSharing } from "./share.js";

const ATTEMPTS = 64;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const CATALOG = "documents";

/** A room refuses a message over 1 MiB. A document past this size cannot seed a room, so it cannot be saved from one. */
export const MAX_LIVE_BYTES = 1_000_000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isWho = (v: unknown): v is { kind: PrincipalKind; name: string } => isObject(v) && PRINCIPAL_KINDS.includes(v.kind as PrincipalKind) && isString(v.name) && v.name !== "";
const isAnchor = (v: unknown): boolean => isObject(v) && isString(v.text) && isObject(v.start) && isObject(v.end);
// The last one is a marker that the Tiptap editor writes when it opens a document. It holds no content.
const ROOTS = new Set(["default", "edits", "suggestions", "threads", "applied", "__tiptap_position_migrations:root:default"]);

/** What the catalog keeps for each document. The author kind stays, so machine-made work stays labeled. */
export interface DocInfo {
  createdBy: { kind: PrincipalKind; name: string };
  createdAt: number;
  /** The name a person gave the document. Without one, a list shows the id. */
  title?: string;
  /** The last save, and who made it. They start as the creation. */
  updatedAt?: number;
  updatedBy?: { kind: PrincipalKind; name: string };
}

/** One row of the document list. */
export interface DocSummary {
  id: string;
  title: string;
  createdBy: DocInfo["createdBy"];
  createdAt: number;
  updatedAt: number;
  updatedBy: DocInfo["createdBy"];
}

export const MAX_TITLE = 120;
/** The scope an agent needs to remove a document. A person needs none. */
export const REMOVE_SCOPE = "docs:remove";
const MAX_LISTED = 500;

export interface DocsPorts {
  /** Holds each document as a Yjs update. Saves are conditional on the version that was read. */
  blobs: Blobs;
  /** Holds the catalog: who created each document, and when. */
  store: Store;
}

/** What every command needs: make a document, read it, and change it. A live room can stand behind it as well as the ports. */
export interface DocAccess {
  /** `context` is the sign-in of the author. Without it, the author alone sets who owns the document. */
  create(id: string, markdown: string, author: Principal, context?: PrincipalContext): Promise<void>;
  read<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T>;
  write<T>(id: string, run: (doc: AgenticDoc) => T, author?: Principal): Promise<T>;
  list(): Promise<DocSummary[]>;
  rename(id: string, title: string, author: Principal): Promise<void>;
  remove(id: string, author: Principal, context?: PrincipalContext): Promise<void>;
  /** Grants, invites, and links. Each call needs an owner of the document. */
  readonly sharing: DocSharing;
}

/** Loads and saves documents as Yjs updates in a Blobs port. The CLI, MCP server, and API share it. */
export class DocsService implements DocAccess {
  private readonly blobs: Blobs;
  private readonly store: Store;
  readonly sharing: StoreSharing;

  constructor(
    ports: DocsPorts,
    private readonly options: DocOptions = {},
  ) {
    this.blobs = ports.blobs;
    this.store = ports.store;
    this.sharing = new StoreSharing(ports.store, {
      exists: async (id) => (await this.blobs.head(this.key(id))) !== null,
      creator: async (id) => (await this.info(id).catch(() => null))?.createdBy,
    });
  }

  private key(id: string): string {
    if (!ID.test(id)) throw new DocError("INVALID_INPUT", `invalid document id "${id}": use 1 to 64 of a-z, 0-9, "-" and "_"`);
    return `${id}.ydoc`;
  }

  async create(id: string, markdown: string, author: Principal, context?: PrincipalContext): Promise<void> {
    const key = this.key(id);
    const created = await this.blobs.put(key, AgenticDoc.fromMarkdown(markdown, author, this.options).encode(), { ifNoneMatch: "*" });
    if (!created) throw new DocError("DOCUMENT_EXISTS", `document "${id}" already exists`);
    await this.catalog(id, author);
    await this.sharing.register(context ?? contextOf(author), id);
  }

  /** The stored document as a Yjs update. A live client seeds its room from it. */
  async state(id: string): Promise<Uint8Array> {
    const found = await this.blobs.get(this.key(id));
    if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    return found.data;
  }

  /**
   * Merge a Yjs update from a live room into the stored document, and create the document when it
   * has none. A merge is safe to repeat and to run in any order. The save is conditional, so two
   * checkpoints at once both land.
   */
  async checkpoint(id: string, update: Uint8Array, author: Principal, options: { create?: boolean } = {}): Promise<void> {
    const key = this.key(id);
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, update); // a bad update must not reach storage
    } catch {
      throw new DocError("INVALID_INPUT", "the update is not a Yjs update");
    }
    if (scratch.store.clients.size === 0 || scratch.store.pendingStructs || scratch.store.pendingDs) {
      throw new DocError("INVALID_INPUT", "the update is empty or lacks the changes it depends on");
    }
    for (const root of scratch.share.keys()) if (!ROOTS.has(root)) throw new DocError("INVALID_INPUT", `the update holds a part this package does not use: "${root}"`);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const found = await this.blobs.get(key);
      if (!found) {
        // A client that only saves, such as the web UI, must not bring back a document that someone removed.
        if (options.create === false) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
        const created = AgenticDoc.fromUpdate(update, this.options);
        const fresh = this.checked(id, created);
        this.fits(id, fresh);
        if (!(await this.blobs.put(key, fresh, { ifNoneMatch: "*" }))) continue;
        await this.catalog(id, author);
        return;
      }
      const doc = AgenticDoc.fromUpdate(found.data, this.options);
      doc.applyUpdate(update);
      const merged = this.checked(id, doc);
      this.fits(id, merged);
      if (await this.blobs.put(key, merged, { ifMatch: found.version })) {
        await this.touch(id, author);
        return;
      }
    }
    throw new DocError("CONFLICT", `document "${id}" kept changing; try again`);
  }

  /**
   * The encoded document, once it reads back and every stored entry has the shape the commands rely on. Yjs does not
   * check types, so an update can put text where the editor expects blocks, or a thread with no messages, and then a
   * command fails on every later call.
   */
  private checked(id: string, doc: AgenticDoc): Uint8Array {
    const refuse = (what: string) => new DocError("INVALID_INPUT", `the update would leave document "${id}" unreadable: ${what}`);
    try {
      doc.toMarkdown();
      if (!doc.edits().every((e) => isObject(e) && isWho(e.author) && isString(e.at) && isString(e.op) && (e.client === undefined || (Number.isSafeInteger(e.client) && (e.client as number) >= 0)))) throw refuse("an edit log entry is malformed");
      for (const [, t] of doc.ydoc.getMap<Y.Map<unknown>>("threads")) {
        const messages = t instanceof Y.Map ? t.get("messages") : undefined;
        const ok = t instanceof Y.Map && isAnchor(t.get("anchor")) && ["open", "resolved"].includes(t.get("status") as string) && messages instanceof Y.Array && messages.length > 0 &&
          messages.toArray().every((m) => isObject(m) && isString(m.id) && isString(m.at) && isString(m.body) && isWho(m.author));
        if (!ok) throw refuse("a thread is malformed");
      }
      for (const [, f] of doc.ydoc.getMap<Y.Map<unknown>>("suggestions")) {
        const ok = f instanceof Y.Map && ["insert", "replace", "delete"].includes(f.get("kind") as string) && ["pending", "accepted", "rejected"].includes(f.get("status") as string) &&
          isAnchor(f.get("anchor")) && isString(f.get("replacement")) && isString(f.get("createdAt")) && isWho(f.get("author"));
        if (!ok) throw refuse("a suggestion is malformed");
      }
      new Suggestions(doc).list();
      new Threads(doc).list();
    } catch (error) {
      throw error instanceof DocError ? error : refuse("a part holds the wrong kind of content");
    }
    return doc.encode();
  }

  private fits(id: string, state: Uint8Array): void {
    if (state.length > MAX_LIVE_BYTES) throw new DocError("INVALID_INPUT", `document "${id}" would pass ${MAX_LIVE_BYTES} bytes, the most a live room takes`);
  }

  private async catalog(id: string, author: Principal): Promise<void> {
    // The blob is the document. The catalog entry follows it, and a repeat leaves the first entry alone.
    await this.store.transaction(async (tx) => {
      if ((await tx.get(CATALOG, id)) === null) {
        const now = Date.now();
        const who = { kind: author.kind, name: author.name };
        await tx.put(CATALOG, id, { createdBy: who, createdAt: now, updatedAt: now, updatedBy: who });
      }
    });
  }

  /**
   * Record a save. The catalog is a side record that follows the blob, so a failure here never fails a save that worked:
   * the caller would repeat a change that is not safe to repeat. A document with no catalog entry stays without one.
   */
  private async touch(id: string, author: Principal | undefined): Promise<void> {
    if (!author) return;
    try {
      await this.store.transaction(async (tx) => {
        const entry = await tx.get(CATALOG, id);
        if (entry !== null) await tx.put(CATALOG, id, { ...entry, updatedAt: Date.now(), updatedBy: { kind: author.kind, name: author.name } });
      });
    } catch {
      /* the list shows an older last edit until the next save */
    }
  }

  /** Every cataloged document, newest first, up to ${MAX_LISTED}. A damaged entry is skipped, so one bad entry never hides the list. */
  async list(): Promise<DocSummary[]> {
    const found: DocSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.query(CATALOG, { orderBy: { field: "createdAt", direction: "desc" }, limit: 100, cursor });
      for (const { id, data } of page.items) {
        const entry = (isObject(data) ? data : {}) as Partial<DocInfo>;
        const { createdBy, createdAt } = entry;
        if (!isWho(createdBy) || typeof createdAt !== "number") continue;
        const by = entry.updatedBy;
        if (by !== undefined && !isWho(by)) continue; // a damaged field is skipped, never guessed
        found.push({ id, title: typeof entry.title === "string" && entry.title !== "" ? entry.title : id, createdBy, createdAt, updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : createdAt, updatedBy: by ?? createdBy });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && found.length < MAX_LISTED);
    return found.slice(0, MAX_LISTED);
  }

  /** Give the document a name. It does not change the text. */
  async rename(id: string, title: string, author: Principal): Promise<void> {
    const key = this.key(id);
    const clean = title.trim();
    // eslint-disable-next-line no-control-regex
    if (clean === "" || [...clean].length > MAX_TITLE || /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(clean)) {
      throw new DocError("INVALID_INPUT", `a title is 1 to ${MAX_TITLE} characters of plain text`);
    }
    const found = await this.blobs.get(key);
    if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    const who = { kind: author.kind, name: author.name };
    // A document with no catalog entry gets one. Its creator is the author of the first logged edit, or this author when the log is empty.
    const first = AgenticDoc.fromUpdate(found.data, this.options).edits()[0];
    const created = first ? { createdBy: { kind: first.author.kind, name: first.author.name }, createdAt: Date.parse(first.at) } : { createdBy: who, createdAt: Date.now() };
    await this.store.transaction(async (tx) => {
      const entry = await tx.get(CATALOG, id);
      const now = Date.now();
      await tx.put(CATALOG, id, entry === null ? { ...created, createdAt: Number.isFinite(created.createdAt) ? created.createdAt : now, title: clean, updatedAt: now, updatedBy: who } : { ...entry, title: clean, updatedAt: now, updatedBy: who });
    });
  }

  /** Delete the document and its catalog entry. An agent needs the remove scope. A live room keeps its own copy of the text. */
  async remove(id: string, author: Principal, context?: PrincipalContext): Promise<void> {
    const key = this.key(id);
    if (!isPerson(author) && author.scopes?.includes(REMOVE_SCOPE) !== true) throw new DocError("FORBIDDEN", `an agent needs the ${REMOVE_SCOPE} scope to remove a document`);
    if (!(await this.blobs.head(key))) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    await this.store.delete(CATALOG, id);
    await this.blobs.delete(key);
    await this.sharing.erase(context ?? contextOf(author), id);
  }

  /** Who created the document and when, or null when it has no catalog entry (made before the catalog, or a failed catalog write). */
  async info(id: string): Promise<DocInfo | null> {
    this.key(id);
    const entry = (await this.store.get(CATALOG, id)) as Partial<DocInfo> | null;
    if (entry === null) return null;
    const { createdBy, createdAt } = entry;
    if (!createdBy || !PRINCIPAL_KINDS.includes(createdBy.kind) || typeof createdBy.name !== "string" || typeof createdAt !== "number") {
      throw new DocError("INVALID_INPUT", `the catalog entry for "${id}" is damaged`);
    }
    return { createdBy, createdAt };
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
  async write<T>(id: string, run: (doc: AgenticDoc) => T, author?: Principal): Promise<T> {
    const key = this.key(id);
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const found = await this.blobs.get(key);
      if (!found) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
      const doc = AgenticDoc.fromUpdate(found.data, this.options);
      const result = run(doc);
      if (await this.blobs.put(key, doc.encode(), { ifMatch: found.version })) {
        await this.touch(id, author);
        return result;
      }
    }
    throw new DocError("CONFLICT", `document "${id}" kept changing; try again`);
  }
}
