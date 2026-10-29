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
  await principal("robot", "agent", ["docs:admin"]); // an agent with its own identity
  for (const id of ["ada", "bea", "scribe", "keeper", "viewer", "robot"]) keys[id] = await issueCredential(store, { principalId: id, kind: "api_key" });
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
