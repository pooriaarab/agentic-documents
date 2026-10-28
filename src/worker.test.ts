// End to end: the real Worker under `wrangler dev` (workerd), plus the closed-by-default check.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
const TOKENS = { "tok-bot": "agent_of_human:scribe", "tok-ada": "human:Ada" };
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
    const odd = await fetch(`${BASE}/api/v1/docs/x/read`, { headers: { authorization: "tok-bot" } });
    expect(odd.status).toBe(401);
  });

  test("with no tokens configured the API is closed", async () => {
    const app = createApp(new DocsService(new MemoryBlobs()));
    const res = await app.request("/api/v1/docs/x/read", { headers: { authorization: "Bearer tok-bot" } }, {});
    expect(res.status).toBe(401);
    const broken = await app.request("/api/v1/docs/x/read", { headers: { authorization: "Bearer tok-bot" } }, { AGENTIC_DOCS_TOKENS: "{oops" });
    expect(broken.status).toBe(401);
  });

  test("a body cannot name its own author", async () => {
    const res = await post("", "tok-bot", { id: "claim", markdown: "x", author: { kind: "human", name: "Ada" } });
    expect(res.status).toBe(400);
    expect((await api("/claim/read", "tok-bot")).status).toBe(404);
  });

  test("bad ids, bad JSON, and unknown routes fail cleanly", async () => {
    expect((await post("", "tok-bot", { id: "../evil", markdown: "x" })).status).toBe(400);
    expect((await api("/x/read", "tok-bot")).status).toBe(404);
    expect((await api("", "tok-bot", { body: "{not json" })).status).toBe(400);
    expect((await api("", "tok-bot", { body: "[1]" })).status).toBe(400);
    const missing = await fetch(`${BASE}/api/v1/nothing`, { headers: { authorization: "Bearer tok-bot" } });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
  });

  test("an ambiguous match is 409 with every context", async () => {
    await post("", "tok-bot", { id: "amb", markdown: "one cat\n\ntwo cat" });
    const res = await post("/amb/replace", "tok-bot", { text: "cat", content: "dog" });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error.code).toBe("AMBIGUOUS_MATCH");
    expect(error.matches).toHaveLength(2);
    expect(await (await api("/amb/read", "tok-bot")).text()).toContain("one cat");
  });

  test("a repeated create is 409", async () => {
    await post("", "tok-bot", { id: "dup" });
    expect((await post("", "tok-bot", { id: "dup" })).status).toBe(409);
  });
});

describe("worker flow", () => {
  test("write, review, and export through the API, with authors from tokens", async () => {
    expect((await post("", "tok-bot", { id: "plan", markdown: "# Plan\n\nShip on Friday & test <b>.\n\n## Risks\n\nNone." })).status).toBe(200);
    const outline = await (await api("/plan/outline", "tok-bot")).json();
    expect(outline.map((s: { title: string }) => s.title)).toEqual(["Plan", "Risks"]);
    expect((await post("/plan/replace", "tok-bot", { section: outline[1].id, content: "Two risks." })).status).toBe(200);
    const { suggestion } = await (await post("/plan/suggest", "tok-bot", { text: "Friday", replacement: "Monday" })).json();
    expect((await api(`/plan/suggestions?status=pending`, "tok-bot")).status).toBe(200);
    expect((await post("/plan/accept", "tok-ada", { suggestion })).status).toBe(200);
    const { thread } = await (await post("/plan/comment", "tok-bot", { text: "Two risks.", body: "Which two?" })).json();
    expect((await post("/plan/reply", "tok-ada", { thread, body: "Cost and time." })).status).toBe(200);

    const md = await api("/plan/read", "tok-ada");
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(await md.text()).toContain("Ship on Monday");
    const threads = await (await api("/plan/threads", "tok-ada")).json();
    expect(threads[0].messages.map((m: { author: { kind: string } }) => m.author.kind)).toEqual(["agent_of_human", "human"]);
    const log = await (await api("/plan/edits", "tok-ada")).json();
    expect(log.at(-1)).toMatchObject({ op: "replace", author: { kind: "human", name: "Ada" }, suggestion: { author: { kind: "agent_of_human" } } });
    expect(log[0].author).toEqual({ kind: "agent_of_human", name: "scribe" });
  });

  test("HTML export is self-contained, escaped, and sandboxed", async () => {
    await post("", "tok-bot", { id: "page", markdown: "# Hi <b> &amp; you\n\n[bad](javascript:alert(1)) and [ok](https://example.org)\n\n```\n<script>x</script>\n```" });
    const res = await api("/page/export?format=html", "tok-ada");
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).toContain("<title>Hi &lt;b&gt; &amp; you</title>");
    expect(html).toContain('<a href="#">bad</a>');
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(html).not.toMatch(/<script|<link|@import|googleapis|\burl\(/i);
    expect((await api("/page/export?format=pdf", "tok-ada")).status).toBe(400);
  });
});
