import * as Y from "yjs";
import { SyncClient, type Peer } from "agentic-realtime/client";
import { AgenticDoc, DocError, PRINCIPAL_KINDS, type DocErrorCode, type DocOptions, type Principal } from "./doc.js";
import { DOC_ERROR_CODES } from "./errors.js";
import { MAX_LIVE_BYTES } from "./service.js";

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
  const code = DOC_ERROR_CODES.find((known) => known === error?.code) ?? "INVALID_INPUT";
  return new DocError(code, typeof error?.message === "string" ? error.message : `${fallback} (${response.status})`);
}

const base = (server: string) => server.replace(/\/$/, "");

export async function whoAmI(server: string, token: string): Promise<Me> {
  const response = await fetch(`${base(server)}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
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
