// End to end: the real Worker under `wrangler dev` (workerd), plus the closed-by-default check.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AgenticDoc } from "./doc.js";
import { exportDoc } from "./export.js";
import { MemoryBlobs } from "./memory-blobs.js";
import { DocsService } from "./service.js";
import { createApp } from "./worker.js";

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

let BASE = "";
// Tokens are 32 bytes or more. Shorter ones are refused.
const BOT = `bot-${"b".repeat(40)}`;
const ADA = `ada-${"a".repeat(40)}`;
const APPROVER = `approver-${"p".repeat(40)}`;
const TOKENS = { [BOT]: "agent_of_human:scribe", [ADA]: "human:Ada", [APPROVER]: { as: "agent_of_human:approver", scopes: ["docs:accept"] } };
let dir: string;
let server: ChildProcess;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentic-documents-worker-"));
  const config = join(dir, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify({ name: "docs-e2e", main: resolve("src/worker.ts"), compatibility_date: "2026-01-01", vars: { AGENTIC_DOCS_TOKENS: JSON.stringify(TOKENS) } }));
  const [port, inspector] = [await freePort(), await freePort()];
  BASE = `http://127.0.0.1:${port}`;
  // Its own process group: workerd children outlive a kill of wrangler alone.
  server = spawn(resolve("node_modules/.bin/wrangler"), ["dev", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--local"], {
    cwd: dir,
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk: Buffer) => (output += chunk));
  for (let i = 0; i < 120; i++) {
    if ((await fetch(`${BASE}/health`).catch(() => undefined))?.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${output.slice(-1500)}`);
}, 90_000);

afterAll(() => {
  if (server?.pid) process.kill(-server.pid, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const api = (path: string, token: string | null, init: { method?: string; body?: unknown } = {}) =>
  fetch(`${BASE}/api/v1/docs${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
const post = (path: string, token: string, body: unknown) => api(path, token, { body });

describe("worker failures", () => {
  test("no token, a wrong token, and a malformed header are 401", async () => {
    expect((await api("/x/read", null)).status).toBe(401);
    expect((await api("/x/read", "nope")).status).toBe(401);
    const odd = await fetch(`${BASE}/api/v1/docs/x/read`, { headers: { authorization: BOT } });
    expect(odd.status).toBe(401);
  });

  test("with no tokens configured the API is closed", async () => {
    const app = createApp(new DocsService(new MemoryBlobs()));
    const res = await app.request("/api/v1/docs/x/read", { headers: { authorization: `Bearer ${BOT}` } }, {});
    expect(res.status).toBe(401);
    const broken = await app.request("/api/v1/docs/x/read", { headers: { authorization: `Bearer ${BOT}` } }, { AGENTIC_DOCS_TOKENS: "{oops" });
    expect(broken.status).toBe(401);
  });

  test("a short token, or a config that is not a table of valid entries, closes the whole API", async () => {
    const app = createApp(new DocsService(new MemoryBlobs()));
    const good = `ok-${"k".repeat(40)}`;
    const ask = (tokens: string) => app.request("/api/v1/docs/x/read", { headers: { authorization: `Bearer ${good}` } }, { AGENTIC_DOCS_TOKENS: tokens });
    expect((await ask(JSON.stringify({ [good]: "human:Ada" }))).status).toBe(404); // valid config: passes auth, no document
    for (const bad of [
      { [good]: "human:Ada", short: "human:Bob" },
      { [good]: "human:Ada", [`b${"b".repeat(30)}`]: "human:Bob" }, // 31 bytes
      { [good]: "robot:r2" },
      { [good]: "human:" },
      { [good]: { as: "human:Ada", scopes: "docs:accept" } },
      { [good]: 7 },
    ]) {
      expect((await ask(JSON.stringify(bad))).status, JSON.stringify(bad)).toBe(401);
    }
    for (const raw of ["null", "[]", '"text"', "7", "{}", "{oops"]) expect((await ask(raw)).status, raw).toBe(401);
  });

  test("an agent token cannot accept over HTTP, and nobody accepts their own suggestion", async () => {
    await post("", BOT, { id: "gate", markdown: "Hello world" });
    const { suggestion } = await (await post("/gate/suggest", BOT, { text: "world", replacement: "moon" })).json();
    const denied = await post("/gate/accept", BOT, { suggestion });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("FORBIDDEN");
    expect(await (await api("/gate/read", ADA)).text()).toBe("Hello world\n");
    const own = await (await post("/gate/suggest", APPROVER, { text: "Hello", replacement: "Bye" })).json();
    expect((await post("/gate/accept", APPROVER, { suggestion: own.suggestion })).status).toBe(403);
    expect((await post("/gate/accept", APPROVER, { suggestion })).status).toBe(200);
    expect((await post("/gate/accept", ADA, { suggestion: own.suggestion })).status).toBe(200);
    expect(await (await api("/gate/read", ADA)).text()).toBe("Bye moon\n");
    const log = await (await api("/gate/edits", ADA)).json();
    expect(JSON.stringify(log)).not.toContain("docs:accept");
  });

  test("a body cannot name its own author", async () => {
    const res = await post("", BOT, { id: "claim", markdown: "x", author: { kind: "human", name: "Ada" } });
    expect(res.status).toBe(400);
    expect((await api("/claim/read", BOT)).status).toBe(404);
  });

  test("bad ids, bad JSON, and unknown routes fail cleanly", async () => {
    expect((await post("", BOT, { id: "../evil", markdown: "x" })).status).toBe(400);
    expect((await api("/x/read", BOT)).status).toBe(404);
    expect((await api("", BOT, { body: "{not json" })).status).toBe(400);
    expect((await api("", BOT, { body: "[1]" })).status).toBe(400);
    const missing = await fetch(`${BASE}/api/v1/nothing`, { headers: { authorization: `Bearer ${BOT}` } });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });

  test("an ambiguous match is 409 with every context", async () => {
    await post("", BOT, { id: "amb", markdown: "one cat\n\ntwo cat" });
    const res = await post("/amb/replace", BOT, { text: "cat", content: "dog" });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe("AMBIGUOUS_MATCH");
    expect(error.matches).toHaveLength(2);
    expect(await (await api("/amb/read", BOT)).text()).toContain("one cat");
  });

  test("a repeated create is 409", async () => {
    await post("", BOT, { id: "dup" });
    expect((await post("", BOT, { id: "dup" })).status).toBe(409);
  });
});

describe("worker flow", () => {
  test("write, review, and export through the API, with authors from tokens", async () => {
    expect((await post("", BOT, { id: "plan", markdown: "# Plan\n\nShip on Friday & test <b>.\n\n## Risks\n\nNone." })).status).toBe(200);
    const outline = await (await api("/plan/outline", BOT)).json();
    expect(outline.map((s: { title: string }) => s.title)).toEqual(["Plan", "Risks"]);
    expect((await post("/plan/replace", BOT, { section: outline[1].id, content: "Two risks." })).status).toBe(200);
    const { suggestion } = await (await post("/plan/suggest", BOT, { text: "Friday", replacement: "Monday" })).json();
    expect((await api(`/plan/suggestions?status=pending`, BOT)).status).toBe(200);
    expect((await post("/plan/accept", ADA, { suggestion })).status).toBe(200);
    const { thread } = await (await post("/plan/comment", BOT, { text: "Two risks.", body: "Which two?" })).json();
    expect((await post("/plan/reply", ADA, { thread, body: "Cost and time." })).status).toBe(200);

    const md = await api("/plan/read", ADA);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("Ship on Monday");
    const threads = await (await api("/plan/threads", ADA)).json();
    expect(threads[0].messages.map((m: { author: { kind: string } }) => m.author.kind)).toEqual(["agent_of_human", "human"]);
    const log = await (await api("/plan/edits", ADA)).json();
    expect(log.at(-1)).toMatchObject({ op: "replace", author: { kind: "human", name: "Ada" }, suggestion: { author: { kind: "agent_of_human" } } });
    expect(log[0].author).toEqual({ kind: "agent_of_human", name: "scribe" });
  });

  test("HTML export drops a remote image by default, so opening it sends no request", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    await post("", BOT, { id: "beacon", markdown: `![tracker](https://tracker.example/a.gif?d=secret)\n\n![rel](/x.png)\n\n![inline](${png})` });
    const res = await api("/beacon/export?format=html", ADA);
    const html = await res.text();
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("/x.png");
    expect(html).toContain("[image: tracker]");
    expect(html).toContain(`<img src="${png}" alt="inline">`);
    expect(res.headers.get("content-security-policy")).toContain("img-src data:;");
    expect(res.headers.get("content-security-policy")).not.toContain("https:");
    const remote = await api("/beacon/export?format=html&remoteImages=true", ADA);
    expect(await remote.text()).toContain('<img src="https://tracker.example/a.gif?d=secret" alt="tracker">');
    expect(remote.headers.get("content-security-policy")).toContain("img-src data: https:");
  });

  test("a heading level or list start that is not a number cannot break the tags", () => {
    const doc = AgenticDoc.fromMarkdown("# Hi\n\n3. one", { kind: "human", name: "Ada" });
    const [heading, list] = doc.ydoc.getXmlFragment("default").toArray() as unknown as { setAttribute(k: string, v: string): void }[];
    heading.setAttribute("level", "abc");
    list.setAttribute("start", "x");
    const html = exportDoc(doc, "html").data;
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain('<ol start="1">');
    expect(html).not.toMatch(/NaN/);
  });

  test("HTML export is self-contained, escaped, and sandboxed", async () => {
    await post("", BOT, { id: "page", markdown: "# Hi <b> &amp; you\n\n[bad](javascript:alert(1)) and [ok](https://example.org)\n\n```\n<script>x</script>\n```" });
    const res = await api("/page/export?format=html", ADA);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain("<title>Hi &lt;b&gt; &amp; you</title>");
    expect(html).toContain('<a href="#">bad</a>');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toMatch(/<script|<link|@import|googleapis|\burl\(/i);
    expect((await api("/page/export?format=pdf", ADA)).status).toBe(400);
  });
});
