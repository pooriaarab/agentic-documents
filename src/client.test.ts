// End to end: the SDK client against the real Worker under `wrangler dev`.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createClient, DocsApiError } from "./client.js";
import { liveServer, type LiveServer } from "./test-server.js";

const ADA = `ada-${"a".repeat(40)}`;
const BOT = `bot-${"b".repeat(40)}`;
const VIEWER = `viewer-${"v".repeat(40)}`;
const SWEEPER = `sweeper-${"s".repeat(40)}`;
const TOKENS = { [ADA]: "human:Ada", [BOT]: "agent_of_human:scribe", [VIEWER]: { as: "human:Vic", role: "viewer" }, [SWEEPER]: { as: "agent_of_human:sweeper", scopes: ["docs:remove"] } };

let server: LiveServer;
beforeAll(async () => {
  server = await liveServer(TOKENS);
  await server.start();
}, 90_000);
afterAll(() => server.dispose());

const as = (token: string) => createClient({ baseUrl: `${server.url}/`, token });
const fails = async (call: Promise<unknown>) => {
  const error = await call.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(DocsApiError);
  return error as DocsApiError;
};

describe("client against the real Worker", () => {
  test("health, me, and the whole write and read loop", async () => {
    const bot = as(BOT);
    expect((await bot.health()).pack).toBe("agentic-documents");
    expect(await bot.me()).toEqual({ kind: "agent_of_human", name: "scribe", scopes: [], role: "editor" });
    expect(await bot.create({ id: "plan", markdown: "# Plan\n\nShip it.\n\n## Risks\n\nNone yet." })).toEqual({ id: "plan" });
    const outline = await bot.outline("plan");
    expect(outline.map((s) => s.title)).toEqual(["Plan", "Risks"]);
    expect(await bot.read("plan", { section: outline[1].id })).toContain("None yet.");
    await bot.replace("plan", { text: "Ship it.", content: "Ship it today." });
    await bot.insert("plan", { section: outline[1].id, at: "end", content: "Watch the cost." });
    await bot.append("plan", { content: "Done." });
    const markdown = await bot.read("plan");
    expect(markdown).toContain("Ship it today.");
    expect(markdown).toContain("Watch the cost.");
    expect(markdown).toContain("Done.");
    await bot.delete("plan", { text: "Done." });
    expect(await bot.read("plan")).not.toContain("Done.");
    const edits = await bot.edits("plan");
    expect(edits.every((e) => e.author.kind === "agent_of_human")).toBe(true);
    expect(await bot.export("plan", { format: "md" })).toContain("Ship it today.");
    expect(await bot.export("plan", { format: "html" })).toContain("<h1");
    const odt = await bot.export("plan", { format: "odt" });
    expect([odt[0], odt[1]]).toEqual([0x50, 0x4b]); // a zip file
  });

  test("suggestions and threads, with the accept scope refused to an agent", async () => {
    const [ada, bot] = [as(ADA), as(BOT)];
    await ada.create({ id: "review", markdown: "# Draft\n\nThe cat sat." });
    const { suggestion } = await bot.suggest("review", { text: "cat", replacement: "dog" });
    expect((await bot.suggestions("review", { status: "pending" })).map((s) => s.id)).toEqual([suggestion]);
    expect((await fails(bot.accept("review", { suggestion }))).code).toBe("FORBIDDEN");
    await ada.accept("review", { suggestion });
    expect(await ada.read("review")).toContain("The dog sat.");
    const { thread } = await bot.comment("review", { text: "sat", body: "Why sat?" });
    await ada.reply("review", { thread, body: "It was tired." });
    await ada.resolve("review", { thread });
    expect((await ada.threads("review", { status: "resolved" }))[0].messages).toHaveLength(2);
    await ada.reopen("review", { thread });
    expect(await ada.threads("review", { status: "resolved" })).toEqual([]);
    await bot.suggest("review", { text: "dog", replacement: "" });
    expect((await ada.suggestions("review", { status: "pending" }))).toHaveLength(1);
    const [pending] = await ada.suggestions("review", { status: "pending" });
    await ada.reject("review", { suggestion: pending.id });
    expect(await ada.suggestions("review", { status: "pending" })).toEqual([]);
  });

  test("state and checkpoint move a Yjs update, and a viewer cannot write", async () => {
    const ada = as(ADA);
    await ada.create({ id: "sync", markdown: "# Sync" });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, await ada.state("sync"));
    expect(copy.share.size).toBeGreaterThan(0);
    expect(await ada.checkpoint("sync", Y.encodeStateAsUpdate(copy))).toEqual({ ok: true });
    expect((await fails(as(VIEWER).checkpoint("sync", new Uint8Array()))).code).toBe("FORBIDDEN");
    expect(await as(VIEWER).read("sync")).toContain("Sync");
    expect((await ada.room("sync")).contributors).toBeInstanceOf(Array);
  });

  test("list, rename, and remove keep the author kind, and an agent needs a scope to remove", async () => {
    const [ada, bot, sweeper, vic] = [as(ADA), as(BOT), as(SWEEPER), as(VIEWER)];
    await bot.create({ id: "cat-a", markdown: "# A" });
    await ada.create({ id: "cat-b", markdown: "# B" });
    await ada.rename("cat-a", { title: "  Plan A  " });
    await ada.append("cat-b", { content: "More." });
    const rows = new Map((await vic.list()).map((r) => [r.id, r]));
    expect(rows.get("cat-a")).toMatchObject({ title: "Plan A", createdBy: { kind: "agent_of_human", name: "scribe" }, updatedBy: { kind: "human", name: "Ada" } });
    expect(rows.get("cat-b")).toMatchObject({ title: "cat-b", updatedBy: { kind: "human", name: "Ada" } });
    expect(rows.get("cat-b")!.updatedAt).toBeGreaterThanOrEqual(rows.get("cat-b")!.createdAt);
    for (const title of ["", "   ", "x".repeat(121), "a\u0000b", "a\u202eb"]) expect((await fails(ada.rename("cat-a", { title }))).code).toBe("INVALID_INPUT");
    expect((await fails(ada.rename("nope", { title: "x" }))).code).toBe("NO_DOCUMENT");
    expect((await fails(vic.rename("cat-a", { title: "x" }))).code).toBe("FORBIDDEN");
    expect((await fails(vic.remove("cat-a"))).code).toBe("FORBIDDEN");
    expect((await fails(bot.remove("cat-a"))).code).toBe("FORBIDDEN");
    await sweeper.remove("cat-a");
    await ada.remove("cat-b");
    expect((await fails(ada.remove("cat-b"))).code).toBe("NO_DOCUMENT");
    expect((await fails(ada.read("cat-b"))).code).toBe("NO_DOCUMENT");
    expect((await ada.list()).map((r) => r.id)).not.toContain("cat-a");
  });

  test("each logged edit names the Yjs client that wrote it, so text can be marked by author kind", async () => {
    const bot = as(BOT);
    await bot.create({ id: "marks", markdown: "# Marks\n\nBy the agent." });
    const copy = new Y.Doc();
    Y.applyUpdate(copy, await bot.state("marks"));
    const [entry] = await bot.edits("marks");
    expect(typeof entry.client).toBe("number");
    const owners = new Set<number>();
    const fragment = copy.getXmlFragment("default");
    for (let item = fragment._first; item; item = item.right) owners.add(item.id.client);
    expect([...owners]).toEqual([entry.client]);
  });

  test("a browser opens a live room with the token in a subprotocol, and the server never echoes it", async () => {
    const protocols = (token: string) => ["agentic-docs", `agentic-docs.bearer.${Buffer.from(token).toString("base64url")}`];
    const open = (token: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`${server.url.replace("http", "ws")}/api/v1/docs/browser/ws`, protocols(token));
        socket.onopen = () => resolve(socket);
        socket.onerror = () => reject(new Error("refused"));
      });
    const socket = await open(ADA);
    expect(socket.protocol).toBe("agentic-docs");
    socket.close();
    await expect(open(`nobody-${"n".repeat(40)}`)).rejects.toThrow("refused");
    // The header is for the live route only: a plain call with the subprotocol and no Authorization header is refused.
    const plain = await fetch(`${server.url}/api/v1/me`, { headers: { "sec-websocket-protocol": protocols(ADA).join(", ") } });
    expect(plain.status).toBe(401);
  });

  test("checkpoint makes a missing document unless create is false", async () => {
    const ada = as(ADA);
    const update = Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getXmlFragment("default"); d.getMap("applied").set("x", 1); return d; })());
    expect((await fails(ada.checkpoint("cp-missing", update, { create: false }))).code).toBe("NO_DOCUMENT");
    expect((await fails(ada.read("cp-missing"))).code).toBe("NO_DOCUMENT");
    expect(await ada.checkpoint("cp-missing", update)).toEqual({ ok: true });
    expect(await ada.read("cp-missing")).toBeDefined();
  });

  test("an auth failure is a typed 401", async () => {
    for (const token of ["nope", `x-${"x".repeat(40)}`]) {
      const error = await fails(as(token).outline("plan"));
      expect([error.code, error.status]).toEqual(["UNAUTHENTICATED", 401]);
    }
  });

  test("not found, ambiguous and conflicting calls carry the code, the status, and the matches", async () => {
    const bot = as(BOT);
    const missing = await fails(bot.read("no-such-doc"));
    expect([missing.code, missing.status]).toEqual(["NO_DOCUMENT", 404]);
    await bot.create({ id: "twice", markdown: "# T\n\nab ab" });
    const dup = await fails(bot.create({ id: "twice" }));
    expect([dup.code, dup.status]).toEqual(["DOCUMENT_EXISTS", 409]);
    const many = await fails(bot.replace("twice", { text: "ab", content: "c" }));
    expect([many.code, many.status, many.matches.length]).toEqual(["AMBIGUOUS_MATCH", 409, 2]);
    expect((await fails(bot.read("twice", { section: "nope" }))).code).toBe("NO_SECTION");
    expect((await fails(bot.insert("twice", { content: "x" } as never))).code).toBe("INVALID_INPUT");
  });

  test("an aborted call rejects, and a write is sent once", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(as(BOT).outline("plan", { signal: controller.signal })).rejects.toThrow();
    let calls = 0;
    const broken = createClient({ baseUrl: server.url, token: BOT, fetch: async () => (calls++, new Response("oops", { status: 502 })) });
    const error = await fails(broken.append("plan", { content: "x" }));
    expect([error.code, error.status, calls]).toEqual(["HTTP_ERROR", 502, 1]);
  });

  test("a 2xx reply that is not what the API sends fails closed", async () => {
    const reply = (body: string, type: string) => createClient({ baseUrl: server.url, token: BOT, fetch: async () => new Response(body, { status: 200, headers: { "content-type": type } }) });
    const page = reply("<html>login</html>", "text/html");
    for (const call of [page.read("a"), page.append("a", { content: "x" }), page.state("a"), page.outline("a")]) expect((await fails(call)).code).toBe("BAD_RESPONSE");
    const empty = reply("{}", "application/json");
    for (const call of [empty.replace("a", { text: "x", content: "y" }), empty.create({ id: "a" }), empty.me(), empty.outline("a")]) expect((await fails(call)).code).toBe("BAD_RESPONSE");
  });

  test("the built client imports nothing at run time", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const built = "dist/client.js";
    if (existsSync(built)) expect(readFileSync(built, "utf8")).not.toMatch(/^\s*import\s|require\(/m);
    expect(readFileSync("src/client.ts", "utf8").match(/^import .*$/gm)?.every((l) => l.startsWith("import type"))).toBe(true);
  });
});
