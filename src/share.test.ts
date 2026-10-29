// Sharing over the HTTP API, signed in with agentic-identity keys. The owner shares. Everyone else gets 403.
import { createMemoryBlobs, createMemoryStore, createStoreAuth, issueCredential } from "agentic-identity";
import { beforeAll, describe, expect, test } from "vitest";
import { DocsService } from "./service.js";
import { createApp } from "./worker.js";

const keys: Record<string, string> = {};
const store = createMemoryStore();
const service = new DocsService({ blobs: createMemoryBlobs(), store });
const app = createApp(service, { auth: () => createStoreAuth(store) });

const principal = (id: string, kind: string, scopes: string[], parentId?: string) => store.put("principals", id, { id, kind, scopes, ...(parentId ? { parentId } : {}) });
const ask = (path: string, token: string | null, body?: unknown) =>
  app.request(`/api/v1/docs${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (res: Response) => (await res.json()) as any;

beforeAll(async () => {
  await principal("ada", "human", ["*:admin"]);
  await principal("bea", "human", ["*:admin"]);
  await principal("scribe", "agent_of_human", ["docs:write"], "ada"); // acts for Ada, with no admin scope
  await principal("keeper", "agent_of_human", ["docs:admin"], "ada"); // acts for Ada, with admin scope
  await principal("viewer", "human", ["docs:read"]);
  await principal("mal", "human", ["docs:write"]); // may write, may not administer
  await principal("robot", "agent", ["docs:admin"]); // an agent with its own identity
  for (const id of ["ada", "bea", "scribe", "keeper", "viewer", "robot", "mal"]) keys[id] = await issueCredential(store, { principalId: id, kind: "api_key" });
  expect((await ask("", keys.ada, { id: "plan", markdown: "# Plan\n\nShip." })).status).toBe(200);
});

describe("the owner shares a document", () => {
  test("the creator owns it, and grant, list, and revoke work", async () => {
    expect(await json(await ask("/plan/grants", keys.ada))).toEqual([{ resourceId: "plan", subjectKind: "human", subjectId: "ada", role: "owner" }]);
    expect((await ask("/plan/grant", keys.ada, { to: "human:kit", role: "editor" })).status).toBe(200);
    expect((await ask("/plan/grant", keys.ada, { to: "agent:kit", role: "viewer" })).status).toBe(200);
    const grants = (await json(await ask("/plan/grants", keys.ada))) as { subjectKind: string; subjectId: string; role: string }[];
    expect(grants.map((g) => `${g.subjectKind}:${g.subjectId}:${g.role}`).sort()).toEqual(["agent:kit:viewer", "human:ada:owner", "human:kit:editor"]);
    expect((await ask("/plan/revoke", keys.ada, { to: "agent:kit" })).status).toBe(200);
    expect((await json(await ask("/plan/grants", keys.ada))).map((g: { subjectKind: string }) => g.subjectKind).sort()).toEqual(["human", "human"]);
  });

  test("an agent that acts for the owner owns what it creates for them", async () => {
    expect((await ask("", keys.scribe, { id: "notes", markdown: "# Notes" })).status).toBe(200);
    expect((await json(await ask("/notes/grants", keys.keeper))).map((g: { subjectId: string }) => g.subjectId)).toEqual(["ada"]);
  });

  test("an invite by email lists with no address, and an invite by handle works", async () => {
    const made = await json(await ask("/plan/invite", keys.ada, { role: "commenter", email: "Kit@Example.com", expiresInMs: 86_400_000 }));
    expect(typeof made.id).toBe("string");
    await ask("/plan/invite", keys.ada, { role: "viewer", handle: "helper" });
    const listed = await (await ask("/plan/invites", keys.ada)).text();
    expect(listed).not.toContain("example.com");
    expect(JSON.parse(listed).map((i: { for: string; role: string }) => `${i.for}:${i.role}`).sort()).toEqual(["email:commenter", "handle:viewer"]);
    expect(await json(await ask("/plan/invite", keys.ada, { role: "owner", email: "a@b.co" }))).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect((await json(await ask("/plan/invite", keys.ada, { role: "viewer", email: "not-an-email" }))).error.code).toBe("INVALID_INPUT");
    expect((await json(await ask("/plan/invite", keys.ada, { role: "viewer" }))).error.code).toBe("INVALID_INPUT");
  });

  test("a share link shows its token once, and it revokes", async () => {
    const link = await json(await ask("/plan/link", keys.ada, { role: "viewer", expiresAt: Date.now() + 60_000, signedInOnly: true }));
    expect(link.token.length).toBeGreaterThanOrEqual(32);
    expect((await ask("/plan/unlink", keys.ada, { link: link.id })).status).toBe(200);
    expect((await ask("/notes/unlink", keys.ada, { link: link.id })).status).toBe(403); // a link of another document
    expect((await json(await ask("/plan/link", keys.ada, { role: "viewer", expiresAt: 1 }))).error.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(await json(await ask("/plan/invites", keys.ada)))).not.toContain(link.token);
  });

  test("an agent that acts for the owner and holds docs:admin may share", async () => {
    expect((await ask("/plan/grant", keys.keeper, { to: "human:kit", role: "viewer" })).status).toBe(200);
  });

  test("the last owner cannot be removed", async () => {
    const res = await ask("/plan/revoke", keys.ada, { to: "human:ada" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("INVALID_INPUT");
  });
});

describe("everyone else is refused with 403", () => {
  const calls: [string, unknown][] = [
    ["/plan/grants", undefined],
    ["/plan/grant", { to: "human:bea", role: "owner" }],
    ["/plan/revoke", { to: "human:kit" }],
    ["/plan/invites", undefined],
    ["/plan/invite", { role: "viewer", email: "x@y.co" }],
    ["/plan/link", { role: "viewer" }],
    ["/plan/unlink", { link: "any" }],
  ];

  test.each(["bea", "viewer", "robot"])("%s, who owns nothing here, cannot do any of it", async (who) => {
    for (const [path, body] of calls) {
      const res = await ask(path, keys[who], body);
      expect(res.status, `${who} ${path}`).toBe(403);
      expect((await json(res)).error.code).toBe("FORBIDDEN");
    }
    expect((await json(await ask("/plan/grants", keys.ada))).map((g: { subjectId: string }) => g.subjectId)).not.toContain("bea");
  });

  test("an agent cannot grant itself a role, by id or as owner", async () => {
    for (const [to, role] of [["agent:scribe", "owner"], ["agent:scribe", "editor"], ["human:ada", "viewer"]]) {
      const res = await ask("/plan/grant", keys.scribe, { to, role });
      expect(res.status, `${to} ${role}`).toBe(403);
    }
    expect((await ask("/plan/grants", keys.scribe)).status).toBe(403);
    expect((await json(await ask("/plan/grants", keys.ada))).map((g: { subjectId: string }) => g.subjectId)).not.toContain("scribe");
  });

  test("a grant does not make an owner of a person with no admin scope", async () => {
    await ask("/plan/grant", keys.ada, { to: "human:viewer", role: "owner" });
    expect((await ask("/plan/grant", keys.viewer, { to: "human:viewer", role: "owner" })).status).toBe(403); // docs:read holds no admin right
    await ask("/plan/revoke", keys.ada, { to: "human:viewer" });
  });

  test("no token is 401, and a missing document is 404 for the owner", async () => {
    expect((await ask("/plan/grants", null)).status).toBe(401);
    expect((await ask("/ghost/grants", keys.ada)).status).toBe(404);
  });
});

describe("a document made before sharing", () => {
  test("its creator becomes the owner on the first call, and nobody else does", async () => {
    await service.create("old", "# Old", { kind: "human", name: "ada" });
    await store.delete("resources", "old");
    await store.delete("grants", "old:human:ada");
    expect((await ask("/old/grants", keys.bea)).status).toBe(403);
    expect((await json(await ask("/old/grants", keys.ada)))[0]).toMatchObject({ subjectId: "ada", role: "owner" });
  });

  test("removing the document erases its grants, so a new one with the same id starts clean", async () => {
    await ask("/plan/grant", keys.ada, { to: "human:kit", role: "editor" });
    expect((await ask("/plan/remove", keys.ada, {})).status).toBe(200);
    expect((await ask("", keys.bea, { id: "plan", markdown: "# Again" })).status).toBe(200);
    expect((await json(await ask("/plan/grants", keys.bea))).map((g: { subjectId: string }) => g.subjectId)).toEqual(["bea"]);
  });
});

describe("a removed document leaves no sharing data for the next one with its id", () => {
  test("a person with only docs:write who removes a document does not keep its id", async () => {
    expect((await ask("", keys.mal, { id: "board", markdown: "# Mal" })).status).toBe(200);
    expect((await ask("/board/remove", keys.mal, {})).status).toBe(200);
    expect((await ask("", keys.ada, { id: "board", markdown: "# Ada, private" })).status).toBe(200);
    expect((await json(await ask("/board/grants", keys.ada))).map((g: { subjectId: string }) => g.subjectId)).toEqual(["ada"]);
    expect((await ask("/board/grants", keys.mal)).status).toBe(403);
  });

  test("an editor who is not an owner removes it, and the old owner, grants, and links go too", async () => {
    await ask("", keys.ada, { id: "deck", markdown: "# Deck" });
    await ask("/deck/grant", keys.ada, { to: "human:bea", role: "editor" });
    const link = await json(await ask("/deck/link", keys.ada, { role: "viewer" }));
    expect((await ask("/deck/remove", keys.bea, {})).status).toBe(200);
    expect((await ask("", keys.bea, { id: "deck", markdown: "# Mine" })).status).toBe(200);
    expect((await json(await ask("/deck/grants", keys.bea))).map((g: { subjectId: string }) => g.subjectId)).toEqual(["bea"]);
    expect((await ask("/deck/grants", keys.ada)).status).toBe(403);
    expect(await store.get("links", link.id)).toBeNull();
  });
});

describe("a document made by a live checkpoint", () => {
  test("is owned by the person the agent acts for", async () => {
    const update = (await service.state("notes")).slice();
    const res = await app.request("/api/v1/docs/fromroom/checkpoint", { method: "POST", headers: { authorization: `Bearer ${keys.scribe}` }, body: update });
    expect(res.status).toBe(200);
    expect((await json(await ask("/fromroom/grants", keys.ada))).map((g: { subjectId: string }) => g.subjectId)).toEqual(["ada"]);
  });
});

describe("the static token table", () => {
  const OWNER = `owner-${"o".repeat(40)}`;
  const VIEW = `view-${"w".repeat(40)}`;
  const ROBOT = `robot-${"r".repeat(40)}`;
  const NOADMIN = `noadmin-${"n".repeat(40)}`;
  const env = { AGENTIC_DOCS_UNSAFE_TOKENS: "1", AGENTIC_DOCS_TOKENS: JSON.stringify({ [OWNER]: "human:Owen", [VIEW]: { as: "human:Owen", role: "viewer" }, [ROBOT]: { as: "agent:robot", scopes: ["docs:admin"] }, [NOADMIN]: { as: "agent:helper", scopes: ["docs:write"] } }) };
  const dev = createApp(new DocsService({ blobs: createMemoryBlobs(), store: createMemoryStore() }));
  const call = (path: string, token: string, body?: unknown) =>
    dev.request(`/api/v1/docs${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

  test("a person owns what they make, and a viewer token with the same name owns and shares nothing", async () => {
    expect((await call("", OWNER, { id: "dev", markdown: "# D" })).status).toBe(200);
    expect((await call("/dev/grant", OWNER, { to: "agent:robot", role: "viewer" })).status).toBe(200);
    expect((await call("/dev/grants", VIEW)).status).toBe(403);
    expect((await call("/dev/grant", VIEW, { to: "human:Owen", role: "owner" })).status).toBe(403);
  });

  test("an agent needs docs:admin and ownership, and it cannot give itself a role", async () => {
    expect((await call("/dev/grants", ROBOT)).status).toBe(403); // robot holds the scope, but only a viewer role
    expect((await call("/dev/grant", ROBOT, { to: "agent:robot", role: "owner" })).status).toBe(403);
    expect((await call("/dev/grant", NOADMIN, { to: "agent:helper", role: "owner" })).status).toBe(403);
    expect((await call("", NOADMIN, { id: "helper-doc", markdown: "# H" })).status).toBe(200);
    expect((await call("/helper-doc/grants", NOADMIN)).status).toBe(403); // it owns the document and holds no admin scope
    expect((await call("", ROBOT, { id: "robot-doc", markdown: "# R" })).status).toBe(200);
    expect((await call("/robot-doc/grants", ROBOT)).status).toBe(200);
  });
});

describe("bad leftovers fail closed", () => {
  test("old sharing data that no owner can erase stops a new document, and nothing of it is made", async () => {
    await store.put("resources", "damaged", { id: "damaged", type: "docs" });
    await store.put("grants", "damaged:human:kit", { resourceId: "damaged", subjectKind: "human", subjectId: "kit", role: "editor" });
    const res = await ask("", keys.ada, { id: "damaged", markdown: "# Mine" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("CONFLICT");
    expect((await ask("/damaged/read", keys.ada)).status).toBe(404);
    expect((await ask("/damaged/grants", keys.ada)).status).toBe(403); // the leftover stays closed to everyone
  });

  test("a resource of another kind with the same id stops a new document and is never trusted", async () => {
    await store.put("resources", "sheet-id", { id: "sheet-id", type: "sheets" });
    await store.put("grants", "sheet-id:human:mal", { resourceId: "sheet-id", subjectKind: "human", subjectId: "mal", role: "owner" });
    expect((await ask("", keys.ada, { id: "sheet-id", markdown: "# Mine" })).status).toBe(409);
    expect((await ask("/sheet-id/read", keys.ada)).status).toBe(404);
    // A document that exists under such an id gives the foreign owner nothing.
    await service.create("sheet-doc", "# Doc", { kind: "human", name: "ada" });
    await store.put("resources", "sheet-doc", { id: "sheet-doc", type: "sheets" });
    await store.put("grants", "sheet-doc:human:mal", { resourceId: "sheet-doc", subjectKind: "human", subjectId: "mal", role: "owner" });
    expect((await ask("/sheet-doc/grants", keys.ada)).status).toBe(403);
    expect((await ask("/sheet-doc/grants", keys.mal)).status).toBe(403); // mal holds docs:write only, and the type is not docs
  });

  test("a resource with children cannot be erased, and the remove fails with CONFLICT, not 500", async () => {
    await ask("", keys.ada, { id: "parent", markdown: "# P" });
    await store.put("resources", "kid", { id: "kid", type: "docs", parentId: "parent" });
    const res = await ask("/parent/remove", keys.ada, {});
    expect(res.status).toBe(409);
    expect((await ask("/parent/read", keys.ada)).status).toBe(200); // the document stays
  });

  test("a development token whose name cannot hold a grant does not lock out the other tokens", async () => {
    const GOOD = `good-${"g".repeat(40)}`;
    const ODD = `odd-${"d".repeat(40)}`;
    const env = { AGENTIC_DOCS_UNSAFE_TOKENS: "1", AGENTIC_DOCS_TOKENS: JSON.stringify({ [GOOD]: "human:ada", [ODD]: "human:bo.b" }) };
    const dev = createApp(new DocsService({ blobs: createMemoryBlobs(), store: createMemoryStore() }));
    const call = (token: string, id: string) => dev.request("/api/v1/docs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id }) }, env);
    expect((await call(GOOD, "one")).status).toBe(200);
    expect((await call(ODD, "two")).status).toBe(200);
    const grants = await dev.request("/api/v1/docs/two/grants", { headers: { authorization: `Bearer ${ODD}` } }, env);
    expect(grants.status).toBe(403); // it can write, and it shares nothing
  });
});
