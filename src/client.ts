// A typed client for the Worker HTTP API. It uses only `fetch`, so it runs in browsers, Workers, and Node 22.
import type { Anchor, EditEntry, Section } from "./doc.js";
import type { ExportFormat } from "./export.js";
import type { Suggestion, Thread } from "./review.js";

export type { Anchor, EditEntry, ExportFormat, Section, Suggestion, Thread };

/** The place an edit goes: a section id, or exact text. */
export interface Where {
  section?: string;
  text?: string;
  occurrence?: number;
  at?: "start" | "end" | "before" | "after";
}

export interface Me {
  kind: string;
  name: string;
  scopes: string[];
  role: "editor" | "viewer";
}

export interface Contributor {
  name: string;
  kind: string;
  machine: boolean;
}

export interface ClientOptions {
  /** The Worker origin, for example `https://docs.example.com`. */
  baseUrl: string;
  /** A bearer token. It sets the author and the role. */
  token: string;
  /** Your own `fetch`. The default is the global one. */
  fetch?: typeof fetch;
}

/** Every call takes this last. `signal` cancels the request. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** The API refused a call, or answered with something else than JSON. `code` is the API error code. */
export class DocsApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly matches: { occurrence: number; context: string }[] = [],
  ) {
    super(message);
    this.name = "DocsApiError";
  }
}

const enc = encodeURIComponent;

/**
 * A client for one Worker. A call that fails with an API error throws `DocsApiError`. A network
 * failure or an abort throws what `fetch` throws. The client never retries: a write is not safe to repeat.
 */
export function createClient(options: ClientOptions) {
  if (!options.token) throw new TypeError("createClient needs a token");
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  async function send(path: string, init: { method: string; body?: BodyInit; json?: boolean; query?: Record<string, unknown> }, call: CallOptions = {}): Promise<Response> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined) params.set(key, String(value));
    const url = `${base}${path}${params.size ? `?${params}` : ""}`;
    const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
    if (init.json) headers["content-type"] = "application/json";
    const response = await doFetch(url, { method: init.method, headers, body: init.body, signal: call.signal });
    if (response.ok) return response;
    let error: { code?: unknown; message?: unknown; matches?: unknown } | undefined;
    try {
      error = ((await response.json()) as { error?: typeof error }).error;
    } catch {
      /* not JSON: fall through */
    }
    throw new DocsApiError(
      typeof error?.code === "string" ? error.code : "HTTP_ERROR",
      typeof error?.message === "string" ? error.message : `the server answered ${response.status}`,
      response.status,
      Array.isArray(error?.matches) ? (error.matches as DocsApiError["matches"]) : [],
    );
  }

  const doc = (id: string) => `/api/v1/docs/${enc(id)}`;
  const get = async <T>(path: string, query: Record<string, unknown>, call?: CallOptions) => (await (await send(path, { method: "GET", query }, call)).json()) as T;
  const post = async <T>(path: string, body: object, call?: CallOptions) => (await (await send(path, { method: "POST", json: true, body: JSON.stringify(body) }, call)).json()) as T;
  const ok = (path: string, body: object, call?: CallOptions) => post<{ ok: true }>(path, body, call);

  return {
    /** `GET /health`. It needs no token, but the client sends it anyway. */
    async health(call?: CallOptions): Promise<{ ok: boolean; pack: string }> {
      return (await (await send("/health", { method: "GET" }, call)).json()) as { ok: boolean; pack: string };
    },
    /** `GET /api/v1/me`: who the token stands for. */
    me: (call?: CallOptions) => get<Me>("/api/v1/me", {}, call),
    /** `POST /api/v1/docs`. */
    create: (input: { id: string; markdown?: string }, call?: CallOptions) => post<{ id: string }>("/api/v1/docs", input, call),
    /** `GET /read`: the whole document, or one section, as Markdown. */
    async read(id: string, input: { section?: string } = {}, call?: CallOptions): Promise<string> {
      return (await send(`${doc(id)}/read`, { method: "GET", query: input }, call)).text();
    },
    outline: (id: string, call?: CallOptions) => get<Section[]>(`${doc(id)}/outline`, {}, call),
    edits: (id: string, call?: CallOptions) => get<EditEntry[]>(`${doc(id)}/edits`, {}, call),
    insert: (id: string, input: Where & { content: string }, call?: CallOptions) => ok(`${doc(id)}/insert`, input, call),
    replace: (id: string, input: Where & { content: string }, call?: CallOptions) => ok(`${doc(id)}/replace`, input, call),
    delete: (id: string, input: Where, call?: CallOptions) => ok(`${doc(id)}/delete`, input, call),
    append: (id: string, input: { content: string }, call?: CallOptions) => ok(`${doc(id)}/append`, input, call),
    suggest: (id: string, input: { text: string; replacement: string; occurrence?: number; at?: "before" | "after" }, call?: CallOptions) =>
      post<{ suggestion: string }>(`${doc(id)}/suggest`, input, call),
    suggestions: (id: string, input: { status?: Suggestion["status"] } = {}, call?: CallOptions) => get<Suggestion[]>(`${doc(id)}/suggestions`, input, call),
    accept: (id: string, input: { suggestion: string }, call?: CallOptions) => ok(`${doc(id)}/accept`, input, call),
    reject: (id: string, input: { suggestion: string }, call?: CallOptions) => ok(`${doc(id)}/reject`, input, call),
    comment: (id: string, input: { text: string; body: string; occurrence?: number }, call?: CallOptions) => post<{ thread: string }>(`${doc(id)}/comment`, input, call),
    reply: (id: string, input: { thread: string; body: string }, call?: CallOptions) => ok(`${doc(id)}/reply`, input, call),
    resolve: (id: string, input: { thread: string }, call?: CallOptions) => ok(`${doc(id)}/resolve`, input, call),
    reopen: (id: string, input: { thread: string }, call?: CallOptions) => ok(`${doc(id)}/reopen`, input, call),
    threads: (id: string, input: { status?: Thread["status"] } = {}, call?: CallOptions) => get<Thread[]>(`${doc(id)}/threads`, input, call),
    /** `GET /export`. `md` and `html` return text. `odt` returns the file bytes. */
    export: (async (id: string, input: { format: ExportFormat; remoteImages?: boolean }, call?: CallOptions) => {
      const response = await send(`${doc(id)}/export`, { method: "GET", query: input }, call);
      return input.format === "odt" ? new Uint8Array(await response.arrayBuffer()) : response.text();
    }) as {
      (id: string, input: { format: "odt"; remoteImages?: boolean }, call?: CallOptions): Promise<Uint8Array>;
      (id: string, input: { format: "md" | "html"; remoteImages?: boolean }, call?: CallOptions): Promise<string>;
    },
    /** `GET /room`: who sent updates in the live room. */
    room: (id: string, call?: CallOptions) => get<{ contributors: Contributor[] }>(`${doc(id)}/room`, {}, call),
    /** `GET /state`: the stored document as a Yjs update. */
    async state(id: string, call?: CallOptions): Promise<Uint8Array> {
      return new Uint8Array(await (await send(`${doc(id)}/state`, { method: "GET" }, call)).arrayBuffer());
    },
    /** `POST /checkpoint`: merge a Yjs update into the stored document. */
    async checkpoint(id: string, update: Uint8Array, call?: CallOptions): Promise<{ ok: true }> {
      return (await (await send(`${doc(id)}/checkpoint`, { method: "POST", body: update as BodyInit }, call)).json()) as { ok: true };
    },
  };
}

export type DocsClient = ReturnType<typeof createClient>;
