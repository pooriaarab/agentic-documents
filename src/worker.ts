import { Hono, type Context } from "hono";
import { assertRegion, createStoreAuth, hasScope, parsePrincipal, parseRegion, type Auth, type PrincipalContext, type Region } from "agentic-identity";
import { acceptWebSocketProtocol, principalFromWebSocketRequest, requirePrincipal } from "agentic-identity/http";
import { D1_SCHEMA, createD1Store, createR2Blobs, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import type { Realtime, Role } from "agentic-realtime";
import { commands, type Command } from "./commands.js";
import { DocError, parseAuthor, type DocErrorCode, type Principal } from "./doc.js";
import { MAX_IMPORT_BASE64 } from "./formats.js";
import type { ExportResult } from "./export.js";
import { DocsService, MAX_LIVE_BYTES } from "./service.js";
import { safeContextOf } from "./share.js";

export interface WorkerEnv {
  /**
   * Where the data lives: "eu" or "us". It is a claim you make at deploy time, with no default.
   * "unknown" skips the region check. Local D1 reports no region, so "unknown" needs `AGENTIC_DOCS_UNSAFE_REGION=1` too.
   */
  AGENTIC_DOCS_REGION?: string;
  /** Set to "1" to accept the region "unknown" under `wrangler dev`. Never set it in production. */
  AGENTIC_DOCS_UNSAFE_REGION?: string;
  /** D1 database: the catalog of documents. Create it with `wrangler d1 create agentic-documents --location weur`. */
  DB?: D1Like;
  /** R2 bucket: each document as a Yjs update. Create it with `--jurisdiction eu`. */
  DOCS?: R2Like;
  /**
   * Development only. Set to "1" to read `AGENTIC_DOCS_TOKENS` as the sign-in. Without it that variable is ignored,
   * and the Worker reads the keys and principals of agentic-identity from the D1 database. Never set it in production.
   */
  AGENTIC_DOCS_UNSAFE_TOKENS?: string;
  /**
   * Development fallback, read only when `AGENTIC_DOCS_UNSAFE_TOKENS` is "1". JSON object: bearer token (32 to 512 bytes of A-Z a-z 0-9 _ -) to `kind:name`, or to `{ "as": "kind:name", "scopes": ["docs:accept"], "role": "viewer" }`.
   * A role is `editor` (the default) or `viewer`. A viewer reads and cannot write, over HTTP or in a live room.
   * Set it as a secret. A short token or a bad entry refuses the whole config.
   */
  AGENTIC_DOCS_TOKENS?: string;
}

const STATUS: Partial<Record<DocErrorCode, number>> = {
  NO_MATCH: 404,
  NO_SECTION: 404,
  NO_THREAD: 404,
  NO_SUGGESTION: 404,
  NO_DOCUMENT: 404,
  AMBIGUOUS_MATCH: 409,
  STALE_ANCHOR: 409,
  ALREADY_DECIDED: 409,
  DOCUMENT_EXISTS: 409,
  CONFLICT: 409,
  FORBIDDEN: 403,
  LOCKED: 503,
  MISCONFIGURED: 500,
};

function same(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const MIN_TOKEN_BYTES = 32;
/** The characters a Bearer credential may hold in agentic-identity, so a token outside it could never sign in. */
const TOKEN_CHARS = /^[A-Za-z0-9_-]{1,512}$/;
const warned = new Set<string>();

function refuse(reason: string): undefined {
  if (!warned.has(reason)) {
    warned.add(reason);
    console.error(`AGENTIC_DOCS_TOKENS is refused: ${reason}`); // never the token or its value
  }
  return undefined;
}

export type DocRole = Extract<Role, "editor" | "viewer">;

/** A token's principal and its role. */
interface Identity {
  principal: Principal;
  role: DocRole;
  /** Who the token stands for, with the chain and scopes of agentic-identity. Sharing reads it. */
  context: PrincipalContext;
}

/** One entry's identity: `"kind:name"`, or `{ "as": "kind:name", "scopes": [...], "role": "viewer" }`. */
function identityOf(entry: unknown): Identity | undefined {
  const object = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as { as?: unknown; scopes?: unknown; role?: unknown }) : undefined;
  if (object?.role !== undefined && object.role !== "editor" && object.role !== "viewer") return undefined;
  const role = (object?.role ?? "editor") as DocRole;
  const principal = principalOf(entry, object);
  if (!principal) return undefined;
  // A viewer token owns nothing and shares nothing, whatever its kind.
  // A name that cannot hold a grant gets no scopes, so the rest of the table still works.
  const context = role === "viewer" ? { ...safeContextOf(principal), scopes: [] } : safeContextOf(principal);
  return { principal, role, context };
}

function principalOf(entry: unknown, object: { as?: unknown; scopes?: unknown } | undefined): Principal | undefined {
  const who = typeof entry === "string" ? entry : object?.as;
  const author = typeof who === "string" ? parseAuthor(who) : undefined;
  if (!author) return undefined;
  try {
    parsePrincipal({ kind: author.kind, id: author.name });
  } catch {
    return undefined;
  }
  if (object?.scopes === undefined) return author;
  const scopes = object.scopes;
  return Array.isArray(scopes) && scopes.every((s) => typeof s === "string" && s !== "") ? { ...author, scopes } : undefined;
}

/**
 * The token table, or nothing. One bad entry (a token under 32 bytes, a value that is not a valid
 * principal) refuses the whole config, so a typo never leaves a weak token live.
 */
function readTokens(raw: string | undefined): Map<string, Identity> | undefined {
  let table: unknown;
  try {
    table = JSON.parse(raw ?? "{}");
  } catch {
    return refuse("not valid JSON");
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) return refuse("not a JSON object");
  const found = new Map<string, Identity>();
  for (const [token, entry] of Object.entries(table)) {
    if (new TextEncoder().encode(token).length < MIN_TOKEN_BYTES) return refuse(`a token is shorter than ${MIN_TOKEN_BYTES} bytes`);
    if (!TOKEN_CHARS.test(token)) return refuse("a token has characters outside A-Z a-z 0-9 _ - or is over 512 bytes");
    const identity = identityOf(entry);
    if (!identity) return refuse("an entry is not a valid kind:name or { as, scopes, role }");
    found.set(token, identity);
  }
  return found;
}

/** The principal a bearer token stands for. The compare visits every entry. */
function identityFor(tokens: string | undefined, bearer: string): Identity | undefined {
  let found: Identity | undefined;
  for (const [token, identity] of readTokens(tokens) ?? []) if (same(token, bearer)) found = identity;
  return found;
}

const fail = (code: string, message: string, status: number, matches: unknown[] = []) =>
  Response.json({ error: { code, message, matches } }, { status });

/** A service, or a function that makes one from the Worker bindings. */
export type ServiceSource = DocsService | ((env: WorkerEnv) => Promise<DocsService>);

type AppEnv = { Bindings: WorkerEnv; Variables: { author: Principal; role: DocRole; context: PrincipalContext } };

export interface AppOptions {
  /** Makes the live-room server from the Worker bindings. Without it, the ws route answers 404. */
  live?: (env: WorkerEnv) => Realtime;
  /** Makes the `Auth` port from the Worker bindings. Without it, the Worker reads agentic-identity keys from the D1 database. */
  auth?: (env: WorkerEnv) => Auth | Promise<Auth>;
}

/** What a principal of agentic-identity may do here. `docs:write` makes an editor, and no write scope makes a viewer. `docs:admin` also grants `docs:accept` and `docs:remove`. */
function identityOfContext(context: PrincipalContext): Identity | undefined {
  try {
    const role: DocRole = hasScope(context.scopes, "docs:write") ? "editor" : "viewer";
    const scopes = hasScope(context.scopes, "docs:admin") ? ["docs:accept", "docs:remove"] : [];
    return { principal: { kind: context.kind, name: context.principalId, ...(scopes.length ? { scopes } : {}) }, role, context };
  } catch {
    return undefined; // a scope the helper cannot read grants nothing
  }
}

let warnedTokens = false;

/** The sign-in for one request: the host's `Auth`, the dev token table when it is switched on, or the keys in D1. */
async function authFor(env: WorkerEnv, options: AppOptions): Promise<{ auth: Auth; identityOf: (context: PrincipalContext) => Identity | undefined }> {
  if (options.auth) return { auth: await options.auth(env), identityOf: identityOfContext };
  if (env.AGENTIC_DOCS_UNSAFE_TOKENS === "1") return tokenAuth(env.AGENTIC_DOCS_TOKENS);
  if (env.AGENTIC_DOCS_TOKENS !== undefined && !warnedTokens) {
    warnedTokens = true;
    console.error("AGENTIC_DOCS_TOKENS is ignored: set AGENTIC_DOCS_UNSAFE_TOKENS=1 for local development, or use agentic-identity keys");
  }
  return { auth: createStoreAuth(await storeOf(env)), identityOf: identityOfContext };
}

/** The body, or INVALID_INPUT when it passes the cap. A body with no length header is cut off at the cap, never read whole. */
async function readCapped(request: Request, cap: number): Promise<Uint8Array> {
  const tooBig = () => new DocError("INVALID_INPUT", `the update is over ${cap} bytes`);
  if (Number(request.headers.get("content-length") ?? 0) > cap) throw tooBig();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
    size += part.value.length;
    if (size > cap) {
      await reader?.cancel();
      throw tooBig();
    }
    chunks.push(part.value);
  }
  const whole = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    whole.set(chunk, at);
    at += chunk.length;
  }
  return whole;
}

/**
 * A browser WebSocket cannot send an Authorization header, but it can offer subprotocols. A browser sends
 * `agentic-docs` and `agentic-docs.bearer.<token in base64url>`. Only the live-room route reads it. The server
 * answers with `agentic-docs` and never echoes the token.
 */
const WS_PROTOCOL = "agentic-docs";

/** The token table as an `Auth` port. The context it returns maps back to its identity. */
function tokenAuth(tokens: string | undefined): { auth: Auth; identityOf: (context: PrincipalContext) => Identity | undefined } {
  const known = new WeakMap<PrincipalContext, Identity>();
  const auth: Auth = {
    async authenticate(request) {
      const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const identity = bearer === undefined ? undefined : identityFor(tokens, bearer);
      if (!identity) return null;
      const { kind, name } = identity.principal;
      // The docs scopes (`docs:accept`) live on `identity.principal`. They are not identity scopes, so the context holds none.
      const context: PrincipalContext = { principalId: name, kind, chain: [{ kind, id: name }], scopes: [] };
      known.set(context, identity);
      return context;
    },
  };
  return { auth, identityOf: (context) => known.get(context) };
}

const DOC_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function createApp(source: ServiceSource, options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
  });
  app.get("/health", (c) => c.json({ ok: true, pack: "agentic-documents" }));
  app.use("/api/v1/*", async (c, next) => {
    const { auth, identityOf } = await authFor(c.env ?? {}, options);
    const socket = c.req.path.endsWith("/ws");
    const found = await (socket ? principalFromWebSocketRequest(c.req.raw, auth, { protocol: WS_PROTOCOL }) : requirePrincipal(c.req.raw, auth));
    const identity = found instanceof Response ? undefined : identityOf(found);
    if (!identity) return fail("UNAUTHENTICATED", "send a valid bearer token", 401);
    c.set("author", identity.principal);
    c.set("role", identity.role);
    c.set("context", identity.context);
    await next();
  });
  // Who the token stands for. A live client reads its author kind here, so it never claims one.
  app.get("/api/v1/me", (c) => {
    const { kind, name, scopes } = c.get("author");
    return c.json({ kind, name, scopes: scopes ?? [], role: c.get("role") });
  });
  // Who sent updates in the room, as the room recorded it from the tokens. The edit log in the document is written by clients.
  app.get("/api/v1/docs/:id/room", async (c) => {
    if (!options.live) return fail("NOT_FOUND", "this server hosts no live rooms", 404);
    if (!DOC_ID.test(c.req.param("id"))) return fail("INVALID_INPUT", `invalid document id "${c.req.param("id")}"`, 400);
    const { contributors } = await options.live(c.env ?? {}).meta(c.req.param("id"));
    return c.json({ contributors: contributors.map(({ id, kind, machine }) => ({ name: id, kind, machine })) });
  });
  // The live room. The token sets the author kind and the role. A viewer joins and reads, and the room drops its writes.
  app.get("/api/v1/docs/:id/ws", async (c) => {
    const id = c.req.param("id");
    if (!options.live) return fail("NOT_FOUND", "this server hosts no live rooms", 404);
    if (c.req.header("upgrade") !== "websocket") return fail("UPGRADE_REQUIRED", "open this route as a WebSocket", 426);
    if (!DOC_ID.test(id)) return fail("INVALID_INPUT", `invalid document id "${id}"`, 400);
    const { kind, name } = c.get("author");
    const room = await options.live(c.env ?? {}).connect(id, c.req.raw, { principal: { id: name, kind }, role: c.get("role"), name });
    return acceptWebSocketProtocol(c.req.raw, room, WS_PROTOCOL);
  });

  async function run(c: Context<AppEnv>, command: Command, input: Record<string, unknown>) {
    try {
      if (!command.readOnly && c.get("role") === "viewer") throw new DocError("FORBIDDEN", "this token is a viewer; it cannot change a document");
      const result = await command.run(await (typeof source === "function" ? source(c.env ?? {}) : source), input, c.get("author"), c.get("context"));
      if (command.name === "export") {
        const { data, contentType, encoding, format, warnings } = result as ExportResult;
        const images = input.remoteImages === true || input.remoteImages === "true" ? "data: https:" : "data:";
        const disposition: Record<string, string> = encoding === "base64" ? { "content-disposition": `attachment; filename="${input.id}.${format}"` } : {};
        // A JSON list with non-ASCII escaped, so the value is a legal header.
        const lost: Record<string, string> = warnings.length ? { "x-export-warnings": JSON.stringify(warnings).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`) } : {};
        const headers = { ...disposition, ...lost, "content-type": contentType, "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; sandbox` };
        return encoding === "base64" ? c.body(Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)), 200, headers) : c.body(data, 200, headers);
      }
      if (typeof result === "string") return c.body(result, 200, { "content-type": "text/markdown; charset=utf-8" });
      return c.json(result);
    } catch (error) {
      if (!(error instanceof DocError)) throw error;
      return fail(error.code, error.message, STATUS[error.code] ?? 400, error.matches);
    }
  }

  async function body(c: Context): Promise<Record<string, unknown>> {
    const parsed: unknown = c.req.path.endsWith("/import")
      ? await (async () => {
        const bytes = await readCapped(c.req.raw, MAX_IMPORT_BASE64 + 1024);
        try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new DocError("INVALID_INPUT", "the body must be JSON"); }
      })()
      : await c.req.json().catch(() => undefined);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new DocError("INVALID_INPUT", "the body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  const serviceOf = (c: Context<AppEnv>) => (typeof source === "function" ? source(c.env ?? {}) : Promise.resolve(source));

  // A live room reads its start state here and saves its state back. These are sync plumbing, not commands.
  app.get("/api/v1/docs/:id/state", async (c) => {
    const state = await (await serviceOf(c)).state(c.req.param("id"));
    return c.body(new Uint8Array(state), 200, { "content-type": "application/octet-stream" });
  });
  app.post("/api/v1/docs/:id/checkpoint", async (c) => {
    if (c.get("role") === "viewer") throw new DocError("FORBIDDEN", "this token is a viewer; it cannot change a document");
    const update = await readCapped(c.req.raw, MAX_LIVE_BYTES);
    await (await serviceOf(c)).checkpoint(c.req.param("id"), update, c.get("author"), { create: c.req.query("create") !== "false", context: c.get("context") });
    return c.json({ ok: true });
  });

  const create = commands.find((c) => c.name === "new")!;
  const listing = commands.find((c) => c.name === "list")!;
  app.post("/api/v1/docs", async (c) => run(c, create, await body(c)));
  app.get("/api/v1/docs", (c) => run(c, listing, {}));
  for (const command of commands.filter((c) => c !== create && c !== listing)) {
    const path = `/api/v1/docs/:id/${command.name}`;
    if (command.readOnly) app.get(path, (c) => run(c, command, { ...c.req.query(), id: c.req.param("id") }));
    else app.post(path, async (c) => run(c, command, { ...(await body(c)), id: c.req.param("id") }));
  }

  app.notFound(() => fail("NOT_FOUND", "no such route", 404));
  app.onError((error) => {
    if (error instanceof DocError) return fail(error.code, error.message, STATUS[error.code] ?? 400, error.matches);
    console.error(error instanceof Error ? error.name : "error");
    return fail("INTERNAL", "the server could not finish the request", 500);
  });
  return app;
}

const schemas = new WeakMap<object, Promise<unknown>>();
// The adapter needs a signing secret. This package never makes signed URLs, so a secret that lives and dies with the isolate is enough.
let urlSecret: string | undefined; // made on first use: a Worker may not make random values at load

/** The region claim, or a MISCONFIGURED error. The HTTP API and the live rooms both use it, so neither runs without it. */
export function regionOf(env: WorkerEnv): Region {
  let region;
  try {
    region = parseRegion(env.AGENTIC_DOCS_REGION);
  } catch {
    throw new DocError("MISCONFIGURED", 'set AGENTIC_DOCS_REGION to "eu" or "us" ("unknown" only for local development)');
  }
  if (region === "unknown" && env.AGENTIC_DOCS_UNSAFE_REGION !== "1") {
    throw new DocError("MISCONFIGURED", 'the region "unknown" turns the residency check off; set AGENTIC_DOCS_UNSAFE_REGION=1 to accept that for local development');
  }
  return region;
}

/** The Store over D1, with its schema made. It holds the catalog, and the principals and keys of agentic-identity. */
async function storeOf(env: WorkerEnv) {
  if (!env.DB) throw new DocError("MISCONFIGURED", "bind a D1 database as DB");
  const db = env.DB;
  const region = regionOf(env);
  let ready = schemas.get(db);
  if (!ready) {
    ready = db.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(db);
      throw error;
    });
    schemas.set(db, ready);
  }
  await ready;
  return createD1Store(db, { region });
}

/** The service over D1 and R2. One region claim covers D1 and R2. The bucket is declared with the "eu" jurisdiction in wrangler.jsonc: keep the two in step. */
export async function serviceFor(env: WorkerEnv): Promise<DocsService> {
  if (!env.DB || !env.DOCS) throw new DocError("MISCONFIGURED", "bind a D1 database as DB and an R2 bucket as DOCS");
  const region = regionOf(env);
  const store = await storeOf(env);
  const blobs = createR2Blobs(env.DOCS, { region, urlBase: "https://invalid.example/unused", urlSecret: (urlSecret ??= `${crypto.randomUUID()}${crypto.randomUUID()}`) });
  assertRegion(region, store, blobs);
  return new DocsService({ store, blobs });
}

const app = createApp(serviceFor);
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
