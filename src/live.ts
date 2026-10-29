import { SyncClient, type Peer } from "agentic-realtime/client";
import { AgenticDoc, DocError, PRINCIPAL_KINDS, type DocOptions, type Principal } from "./doc.js";

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
}

/** Who the server says the token is. */
export interface Me {
  author: Principal;
  role: "editor" | "viewer";
}

const base = (server: string) => server.replace(/\/$/, "");

export async function whoAmI(server: string, token: string): Promise<Me> {
  const response = await fetch(`${base(server)}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new DocError("FORBIDDEN", `the server refused the token (${response.status})`);
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
    return new LiveDoc(new AgenticDoc(client.doc, options.doc), me, client);
  }

  /** The other people and agents in the room. `machine` is true for an agent. */
  get peers(): Peer[] {
    return this.client.peers;
  }

  get denied(): string[] {
    return this.client.denied;
  }

  /** Runs one change as the token's author and waits until the room has it. A viewer fails before the change. */
  async edit<T>(run: (doc: AgenticDoc, author: Principal) => T): Promise<T> {
    if (this.me.role === "viewer") throw new DocError("FORBIDDEN", "this token is a viewer; it cannot change a document");
    const seen = this.client.denied.length;
    const result = run(this.doc, this.me.author);
    await this.client.flush();
    if (this.client.denied.length > seen) throw new DocError("FORBIDDEN", `the room refused the edit: ${this.client.denied[seen]}`);
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
