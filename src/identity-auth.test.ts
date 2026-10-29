// The Worker signs in with agentic-identity keys by default. The static token table is a development fallback behind an explicit switch.
import { createMemoryBlobs, createMemoryStore, createStoreAuth, issueCredential, revokeCredential } from "agentic-identity";
import { beforeAll, describe, expect, test } from "vitest";
import { DocsService } from "./service.js";
import { createApp } from "./worker.js";

const STATIC = `static-${"s".repeat(40)}`;
const keys: Record<string, string> = {};
const store = createMemoryStore();
const service = new DocsService({ blobs: createMemoryBlobs(), store });
const app = createApp(service, { auth: () => createStoreAuth(store) });

const principal = (id: string, kind: string, scopes: string[], parentId?: string) => store.put("principals", id, { id, kind, scopes, ...(parentId ? { parentId } : {}) });
const ask = (path: string, token: string | null, init: RequestInit = {}) =>
  app.request(`/api/v1${path}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" } });

beforeAll(async () => {
  await principal("ada", "human", ["*:admin"]);
  await principal("scribe", "agent_of_human", ["docs:write"], "ada");
  await principal("reader", "agent_of_human", ["docs:read"], "ada");
  await principal("approver", "agent_of_human", ["docs:admin"], "ada");
  for (const id of ["ada", "scribe", "reader", "approver"]) keys[id] = await issueCredential(store, { principalId: id, kind: "api_key" });
});

describe("sign-in with agentic-identity keys", () => {
  test("a key signs in as its principal, and the edit carries the author kind", async () => {
    expect(await (await ask("/me", keys.scribe)).json()).toEqual({ kind: "agent_of_human", name: "scribe", scopes: [], role: "editor" });
    expect((await ask("/docs", keys.scribe, { method: "POST", body: JSON.stringify({ id: "plan", markdown: "# Plan\n\nShip." }) })).status).toBe(200);
    const edits = (await (await ask("/docs/plan/edits", keys.ada)).json()) as { author: { kind: string; name: string } }[];
    expect(edits.map((e) => `${e.author.kind}:${e.author.name}`)).toContain("agent_of_human:scribe");
  });

  test("a principal with no write scope is a viewer", async () => {
    expect((await (await ask("/me", keys.reader)).json()) as { role: string }).toMatchObject({ role: "viewer" });
    expect((await ask("/docs/plan/read", keys.reader)).status).toBe(200);
    expect((await ask("/docs/plan/append", keys.reader, { method: "POST", body: JSON.stringify({ markdown: "No." }) })).status).toBe(403);
  });

  test("docs:admin grants the accept and remove scopes, and docs:write does not", async () => {
    expect(await (await ask("/me", keys.approver)).json()).toMatchObject({ scopes: ["docs:accept", "docs:remove"], role: "editor" });
    expect(((await (await ask("/me", keys.scribe)).json()) as { scopes: string[] }).scopes).toEqual([]);
    expect((await ask("/docs/plan/remove", keys.scribe, { method: "POST", body: "{}" })).status).toBe(403);
  });

  test("no key, an unknown key, a revoked key, and a static token are 401", async () => {
    const gone = await issueCredential(store, { principalId: "scribe", kind: "api_key" });
    expect((await ask("/me", gone)).status).toBe(200);
    await revokeCredential(store, gone, Date.now());
    for (const token of [null, "nope", gone, STATIC]) expect((await ask("/me", token)).status, String(token)).toBe(401);
  });
});

describe("the static token table", () => {
  const request = (env: object) => createApp(service).request("/api/v1/me", { headers: { authorization: `Bearer ${STATIC}` } }, env);
  const tokens = JSON.stringify({ [STATIC]: "human:Ada" });

  test("is ignored without the switch, so a stray variable opens nothing", async () => {
    // With no D1 database the Worker has nothing to read keys from, and it refuses. It never falls back to the table.
    const res = await request({ AGENTIC_DOCS_TOKENS: tokens });
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.code).toBe("MISCONFIGURED");
  });

  test("works only with AGENTIC_DOCS_UNSAFE_TOKENS=1", async () => {
    expect((await request({ AGENTIC_DOCS_TOKENS: tokens, AGENTIC_DOCS_UNSAFE_TOKENS: "1" })).status).toBe(200);
    expect((await request({ AGENTIC_DOCS_TOKENS: tokens, AGENTIC_DOCS_UNSAFE_TOKENS: "true" })).status).toBe(500);
  });
});
