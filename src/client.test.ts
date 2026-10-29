// End to end: the SDK client against the real Worker under `wrangler dev`.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { createClient, DocsApiError } from "./client.js";
import { liveServer, type LiveServer } from "./test-server.js";

const ADA = `ada-${"a".repeat(40)}`;
const BOT = `bot-${"b".repeat(40)}`;
const VIEWER = `viewer-${"v".repeat(40)}`;
const TOKENS = { [ADA]: "human:Ada", [BOT]: "agent_of_human:scribe", [VIEWER]: { as: "human:Vic", role: "viewer" } };

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
