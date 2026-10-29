import * as Y from "yjs";
import { SyncClient, type Peer } from "agentic-realtime/client";
import { AgenticDoc, DocError, PRINCIPAL_KINDS, type DocOptions, type Principal } from "./doc.js";
import { DOC_ERROR_CODES } from "./errors.js";
import { MAX_LIVE_BYTES, type DocAccess, type DocSummary } from "./service.js";

export interface LiveOptions {
  /** The Worker address, such as `https://docs.example.com`. */
  server: string;
  /** Document id. */
  id: string;
  /** A bearer token. The server maps it to the author kind and the role. */
  token: string;
  /** The name other people see in presence. Defaults to the author name. */
  name?: string;
  /** Reconnect after a drop. Edits made offline merge when the socket returns. */
  reconnect?: { initialMs?: number; maxMs?: number };
  doc?: DocOptions;
  /** Start an empty room from the stored document. Default true. A merge is safe when the room already holds it. */
  seed?: boolean;
}

/** Who the server says the token is. */
export interface Me {
  author: Principal;
  role: "editor" | "viewer";
}

/** The server's error as a DocError. The code must be one this package knows. */
async function refusal(response: Response, fallback: string): Promise<DocError> {
  const { error } = (await response.json().catch(() => ({}))) as { error?: { code?: unknown; message?: unknown } };
  const code = DOC_ERROR_CODES.find((known) => known === error?.code) ?? (response.status >= 500 ? "MISCONFIGURED" : "INVALID_INPUT");
  return new DocError(code, typeof error?.message === "string" ? error.message : `${fallback} (${response.status})`);
}

const base = (server: string) => server.replace(/\/$/, "");

export async function whoAmI(server: string, token: string): Promise<Me> {
  const response = await fetch(`${base(server)}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }).catch((error: unknown) => {
    throw unreachable(error);
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new DocError("FORBIDDEN", `the server refused the token (${response.status})`);
    throw await refusal(response, "the server could not say who the token is");
  }
  const body = (await response.json()) as { kind?: unknown; name?: unknown; scopes?: unknown; role?: unknown };
  const { kind, name, scopes, role } = body;
  if (!PRINCIPAL_KINDS.includes(kind as never) || typeof name !== "string" || (role !== "editor" && role !== "viewer")) {
    throw new DocError("INVALID_INPUT", "the server sent an identity this client does not know");
  }
  const granted = Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [];
  return { author: { kind: kind as Principal["kind"], name, ...(granted.length ? { scopes: granted } : {}) }, role };
}

/**
 * One document, open in a live room. The author of every edit is the one the server reads from the
 * token, so an agent token always writes agent edits. The room keeps the edits, the stored author
 * label of each update, and the state for the next join.
 */
export class LiveDoc {
  private constructor(
    readonly doc: AgenticDoc,
    readonly me: Me,
    private readonly client: SyncClient,
    private readonly api: (path: string, init?: RequestInit) => Promise<Response>,
    private readonly refusedAtStart: number,
  ) {}

  static async join(options: LiveOptions): Promise<LiveDoc> {
    const me = await whoAmI(options.server, options.token);
    const url = new URL(`${base(options.server)}/api/v1/docs/${encodeURIComponent(options.id)}/ws`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const client = await SyncClient.connect({
      url: url.toString(),
      headers: { authorization: `Bearer ${options.token}` },
      presence: { name: options.name ?? me.author.name },
      reconnect: options.reconnect,
    });
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${base(options.server)}/api/v1/docs/${encodeURIComponent(options.id)}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${options.token}` },
      });
    try {
      if (options.seed !== false) {
        const stored = await api("/state");
        if (stored.ok) {
          const state = new Uint8Array(await stored.arrayBuffer());
          if (state.length > MAX_LIVE_BYTES) throw new DocError("INVALID_INPUT", `the stored document is over ${MAX_LIVE_BYTES} bytes, the most a live room takes`);
          Y.applyUpdate(client.doc, state);
        } else if (stored.status !== 404) throw await refusal(stored, "could not read the stored document");
        await client.flush();
        // A room drops a viewer's seed, and that is no refusal of an edit. An editor's refused seed is an error.
        if (me.role === "editor" && client.denied.length > 0) throw new DocError("FORBIDDEN", `the room refused the stored document: ${client.denied[0]}`);
      }
    } catch (error) {
      // Never leave the client open: with reconnect it would retry the seed for ever.
      await client.disconnect();
      throw error instanceof DocError ? error : new DocError("INVALID_INPUT", `could not open the room: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new LiveDoc(new AgenticDoc(client.doc, options.doc), me, client, api, client.denied.length);
  }

  /** Saves the room's state to the stored document, through the Blobs port. A viewer cannot save. */
  async save(): Promise<void> {
    if (this.me.role === "viewer") throw new DocError("FORBIDDEN", "this token is a viewer; it cannot change a document");
    await this.client.flush();
    const saved = await this.api("/checkpoint", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(this.doc.encode()) });
    if (!saved.ok) throw await refusal(saved, "the server did not save the document");
  }

  /** The other people and agents in the room. `machine` is true for an agent. */
  get peers(): Peer[] {
    return this.client.peers;
  }

  /** Why the room dropped an update, in order. */
  get denied(): string[] {
    return this.client.denied.slice(this.refusedAtStart);
  }

  /**
   * Runs one change as the token's author and waits until the room has it. A viewer fails before the change.
   * After a refusal from the room the local copy still holds the change. Leave and join again.
   */
  async edit<T>(run: (doc: AgenticDoc, author: Principal) => T): Promise<T> {
    if (this.me.role === "viewer") throw new DocError("FORBIDDEN", "this token is a viewer; it cannot change a document");
    const seen = this.denied.length;
    const result = run(this.doc, this.me.author);
    await this.client.flush();
    if (this.denied.length > seen) throw new DocError("FORBIDDEN", `the room refused the edit: ${this.denied[seen]}`);
    return result;
  }

  /** Waits until the room has every change made so far. */
  flush(): Promise<void> {
    return this.client.flush();
  }

  async leave(): Promise<void> {
    await this.client.disconnect();
  }
}

/** A DocError for a connection that failed, so a caller gets one error shape. A DocError passes through. */
function unreachable(error: unknown): DocError {
  if (error instanceof DocError) return error;
  return new DocError("MISCONFIGURED", `could not reach the live server: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * The commands of the CLI and the MCP server, run in a live room. Each call joins the room, runs one
 * change as the token's author, saves to the stored document, and leaves. A read joins and leaves.
 */
export class LiveService implements DocAccess {
  constructor(private readonly options: Pick<LiveOptions, "server" | "token" | "name" | "doc">) {}

  private async join(id: string): Promise<LiveDoc> {
    try {
      return await LiveDoc.join({ ...this.options, id });
    } catch (error) {
      throw unreachable(error);
    }
  }

  private async call(path: string, init: { method: string; body?: object }): Promise<Response> {
    const response = await fetch(`${base(this.options.server)}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${this.options.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }).catch((error: unknown) => {
      throw unreachable(error);
    });
    if (!response.ok) throw await refusal(response, "the server refused the request");
    return response;
  }

  /** The room is only a copy, so a new document is made in the store. A room seeds from it on the next join. */
  async create(id: string, markdown: string): Promise<void> {
    await this.call("/api/v1/docs", { method: "POST", body: { id, markdown } });
  }

  // The catalog lives in the store, not in a room, so these go to the HTTP API.
  async list(): Promise<DocSummary[]> {
    const body: unknown = await (await this.call("/api/v1/docs", { method: "GET" })).json().catch(() => undefined);
    const row = (r: unknown) => typeof r === "object" && r !== null && typeof (r as DocSummary).id === "string" && typeof (r as DocSummary).title === "string" && typeof (r as DocSummary).updatedAt === "number";
    if (!Array.isArray(body) || !body.every(row)) throw new DocError("INVALID_INPUT", "the server sent a document list that is not valid");
    return body as DocSummary[];
  }

  async rename(id: string, title: string): Promise<void> {
    await this.call(`/api/v1/docs/${encodeURIComponent(id)}/rename`, { method: "POST", body: { title } });
  }

  async remove(id: string): Promise<void> {
    await this.call(`/api/v1/docs/${encodeURIComponent(id)}/remove`, { method: "POST", body: {} });
  }

  async read<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T> {
    const live = await this.join(id);
    try {
      return run(this.exists(live, id));
    } finally {
      await live.leave();
    }
  }

  async write<T>(id: string, run: (doc: AgenticDoc) => T): Promise<T> {
    const live = await this.join(id);
    try {
      this.exists(live, id);
      const result = await live.edit((doc) => run(doc));
      try {
        await live.save();
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new DocError(error instanceof DocError ? error.code : "MISCONFIGURED", `the room has the change, but it is not saved: ${why}. Do not repeat the change.`);
      }
      return result;
    } finally {
      await live.leave();
    }
  }

  // A document that nobody made has an empty room and an empty log.
  private exists(live: LiveDoc, id: string): AgenticDoc {
    if (live.doc.edits().length === 0) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    return live.doc;
  }
}
