import { Hono, type Context } from "hono";
import { assertRegion, parseRegion } from "agentic-identity";
import { D1_SCHEMA, createD1Store, createR2Blobs, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { commands, type Command } from "./commands.js";
import { DocError, parseAuthor, PRINCIPAL_KINDS, type DocErrorCode, type Principal } from "./doc.js";
import type { ExportResult } from "./export.js";
import { DocsService } from "./service.js";

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
   * JSON object: bearer token (32 bytes or more) to `kind:name`, or to `{ "as": "kind:name", "scopes": ["docs:accept"] }`.
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
const warned = new Set<string>();

function refuse(reason: string): undefined {
  if (!warned.has(reason)) {
    warned.add(reason);
    console.error(`AGENTIC_DOCS_TOKENS is refused: ${reason}`); // never the token or its value
  }
  return undefined;
}

/** One entry's principal: `"kind:name"`, or `{ "as": "kind:name", "scopes": ["docs:accept"] }`. */
function principalOf(entry: unknown): Principal | undefined {
  const object = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as { as?: unknown; scopes?: unknown }) : undefined;
  const who = typeof entry === "string" ? entry : object?.as;
  const author = typeof who === "string" ? parseAuthor(who) : undefined;
  if (!author || !PRINCIPAL_KINDS.includes(author.kind) || !author.name) return undefined;
  if (object?.scopes === undefined) return author;
  const scopes = object.scopes;
  return Array.isArray(scopes) && scopes.every((s) => typeof s === "string" && s !== "") ? { ...author, scopes } : undefined;
}

/**
 * The token table, or nothing. One bad entry (a token under 32 bytes, a value that is not a valid
 * principal) refuses the whole config, so a typo never leaves a weak token live.
 */
function readTokens(raw: string | undefined): Map<string, Principal> | undefined {
  let table: unknown;
  try {
    table = JSON.parse(raw ?? "{}");
  } catch {
    return refuse("not valid JSON");
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) return refuse("not a JSON object");
  const found = new Map<string, Principal>();
  for (const [token, entry] of Object.entries(table)) {
    if (new TextEncoder().encode(token).length < MIN_TOKEN_BYTES) return refuse(`a token is shorter than ${MIN_TOKEN_BYTES} bytes`);
    const principal = principalOf(entry);
    if (!principal) return refuse("an entry is not a valid kind:name or { as, scopes }");
    found.set(token, principal);
  }
  return found;
}

/** The principal a bearer token stands for. The compare visits every entry. */
function principalFor(tokens: string | undefined, bearer: string): Principal | undefined {
  let found: Principal | undefined;
  for (const [token, principal] of readTokens(tokens) ?? []) if (same(token, bearer)) found = principal;
  return found;
}

const fail = (code: string, message: string, status: number, matches: unknown[] = []) =>
  Response.json({ error: { code, message, matches } }, { status });

/** A service, or a function that makes one from the Worker bindings. */
export type ServiceSource = DocsService | ((env: WorkerEnv) => Promise<DocsService>);

export function createApp(source: ServiceSource): Hono<{ Bindings: WorkerEnv; Variables: { author: Principal } }> {
  const app = new Hono<{ Bindings: WorkerEnv; Variables: { author: Principal } }>();

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
  });
  app.get("/health", (c) => c.json({ ok: true, pack: "agentic-documents" }));
  app.use("/api/v1/*", async (c, next) => {
    const bearer = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    const author = bearer === undefined ? undefined : principalFor(c.env?.AGENTIC_DOCS_TOKENS, bearer);
    if (!author) return fail("UNAUTHENTICATED", "send a valid bearer token", 401);
    c.set("author", author);
    await next();
  });

  async function run(c: Context<{ Bindings: WorkerEnv; Variables: { author: Principal } }>, command: Command, input: Record<string, unknown>) {
    try {
      const result = await command.run(await (typeof source === "function" ? source(c.env ?? {}) : source), input, c.get("author"));
      if (command.name === "export") {
        const { data, contentType, encoding, format } = result as ExportResult;
        const images = input.remoteImages === true || input.remoteImages === "true" ? "data: https:" : "data:";
        const disposition: Record<string, string> = format === "odt" ? { "content-disposition": `attachment; filename="${input.id}.odt"` } : {};
        const headers = { ...disposition, "content-type": contentType, "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; img-src ${images}; sandbox` };
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
    const parsed: unknown = await c.req.json().catch(() => undefined);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new DocError("INVALID_INPUT", "the body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  const create = commands.find((c) => c.name === "new")!;
  app.post("/api/v1/docs", async (c) => run(c, create, await body(c)));
  for (const command of commands.filter((c) => c !== create)) {
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

/** The service over D1 and R2. The R2 bucket is declared with the "eu" jurisdiction in wrangler.jsonc. */
async function serviceFor(env: WorkerEnv): Promise<DocsService> {
  if (!env.DB || !env.DOCS) throw new DocError("MISCONFIGURED", "bind a D1 database as DB and an R2 bucket as DOCS");
  let region;
  try {
    region = parseRegion(env.AGENTIC_DOCS_REGION);
  } catch {
    throw new DocError("MISCONFIGURED", 'set AGENTIC_DOCS_REGION to "eu" or "us" ("unknown" only for local development)');
  }
  if (region === "unknown" && env.AGENTIC_DOCS_UNSAFE_REGION !== "1") {
    throw new DocError("MISCONFIGURED", 'the region "unknown" turns the residency check off; set AGENTIC_DOCS_UNSAFE_REGION=1 to accept that for local development');
  }
  const db = env.DB;
  let ready = schemas.get(db);
  if (!ready) {
    ready = db.prepare(D1_SCHEMA).run().catch((error: unknown) => {
      schemas.delete(db);
      throw error;
    });
    schemas.set(db, ready);
  }
  await ready;
  return new DocsService({
    store: createD1Store(db, { region }),
    blobs: createR2Blobs(env.DOCS, { region: "eu", urlBase: "https://invalid.example/unused", urlSecret: (urlSecret ??= `${crypto.randomUUID()}${crypto.randomUUID()}`) }),
  });
}

const app = createApp(serviceFor);
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
