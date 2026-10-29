// End to end: the real Worker with live rooms under `wrangler dev`, and real LiveDoc clients.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SyncClient } from "agentic-realtime/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DocError } from "./doc.js";
import { LiveDoc } from "./live.js";

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

const ADA = `ada-${"a".repeat(40)}`;
const BOT = `bot-${"b".repeat(40)}`;
const VIEWER = `viewer-${"v".repeat(40)}`;
const NOBODY = `nobody-${"n".repeat(40)}`;
const TOKENS = { [ADA]: "human:Ada", [BOT]: "agent_of_human:scribe", [VIEWER]: { as: "human:Vic", role: "viewer" } };

let dir: string;
let port = 0;
let server: ChildProcess | undefined;
const SERVER = () => `http://127.0.0.1:${port}`;

async function start(): Promise<void> {
  const config = join(dir, "wrangler.jsonc");
  const inspector = await freePort();
  server = spawn(resolve("node_modules/.bin/wrangler"), ["dev", "--config", config, "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--local", "--persist-to", join(dir, "state")], {
    cwd: dir,
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk: Buffer) => (output += chunk));
  for (let i = 0; i < 120; i++) {
    if ((await fetch(`${SERVER()}/health`).catch(() => undefined))?.ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${output.slice(-1500)}`);
}

function stop(): void {
  if (server?.pid) process.kill(-server.pid, "SIGKILL");
  server = undefined;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agentic-documents-live-"));
  port = await freePort();
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "docs-live",
      main: resolve("src/live-worker.ts"),
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: { bindings: [{ name: "SYNC_ROOM", class_name: "SyncRoom" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SyncRoom"] }],
      d1_databases: [{ binding: "DB", database_name: "docs-live", database_id: "00000000-0000-0000-0000-000000000000" }],
      r2_buckets: [{ binding: "DOCS", bucket_name: "docs-live", jurisdiction: "eu" }],
      vars: { AGENTIC_DOCS_TOKENS: JSON.stringify(TOKENS), AGENTIC_DOCS_REGION: "unknown", AGENTIC_DOCS_UNSAFE_REGION: "1" },
    }),
  );
  await start();
}, 90_000);

afterAll(() => {
  stop();
  rmSync(dir, { recursive: true, force: true });
});

const join_ = (id: string, token: string, extra: object = {}) => LiveDoc.join({ server: SERVER(), id, token, ...extra });
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!check()) throw new Error(`timed out waiting for ${what}`);
};

describe("a human and an agent in one room", () => {
  test("concurrent edits converge and the agent's edits are labeled as agent edits", async () => {
    const human = await join_("converge", ADA);
    await human.edit((d, a) => d.append("# Plan\n\nShip on Friday.\n\n## Risks\n\nNone yet.", a));
    const agent = await join_("converge", BOT);
    await until(() => agent.doc.toMarkdown().includes("Ship on Friday"), "the agent to see the plan");
    expect(agent.me.author).toEqual({ kind: "agent_of_human", name: "scribe" });

    const [, risks] = human.doc.outline();
    await Promise.all([
      human.edit((d, a) => d.insert({ text: "Friday", at: "after" }, " morning", a)),
      agent.edit((d, a) => d.replace({ section: risks.id }, "Two risks.", a)),
    ]);
    await until(() => human.doc.toMarkdown() === agent.doc.toMarkdown() && human.doc.toMarkdown().includes("Two risks."), "both clients to converge");
    const text = human.doc.toMarkdown();
    expect(text).toContain("Ship on Friday morning.");
    expect(text).toContain("Two risks.");
    expect(text).not.toContain("None yet");

    const byKind = human.doc.edits().map((e) => `${e.author.kind}:${e.author.name}:${e.op}`);
    expect(byKind).toContain("human:Ada:insert");
    expect(byKind).toContain("agent_of_human:scribe:replace");
    expect(human.peers.map((p) => [p.kind, p.machine])).toEqual([["agent_of_human", true]]);
    expect(agent.peers.map((p) => [p.kind, p.machine])).toEqual([["human", false]]);
    await Promise.all([human.leave(), agent.leave()]);
  });

  test("a room restart and a new client recover the document", async () => {
    const first = await join_("recover", ADA);
    await first.edit((d, a) => d.append("# Notes\n\nKept in the room.", a));
    await first.leave();
    stop();
    await start();
    const second = await join_("recover", BOT);
    expect(second.doc.toMarkdown()).toContain("Kept in the room.");
    expect(second.doc.edits()[0].author).toMatchObject({ kind: "human", name: "Ada" });
    await second.leave();
  }, 120_000);

  test("a client that loses the server reconnects and merges what it wrote offline", async () => {
    const human = await join_("offline", ADA, { reconnect: { initialMs: 100, maxMs: 500 } });
    await human.edit((d, a) => d.append("# Log\n\nOne.", a));
    const agent = await join_("offline", BOT, { reconnect: { initialMs: 100, maxMs: 500 } });
    await until(() => agent.doc.toMarkdown().includes("One."), "the agent to sync");
    stop();
    // The agent writes while the server is down. The write waits in the local copy.
    agent.doc.append("Two, written offline.", agent.me.author);
    await start();
    await until(() => human.doc.toMarkdown().includes("Two, written offline."), "the offline edit to reach the human");
    await Promise.all([human.leave(), agent.leave()]);
  }, 120_000);
});

describe("permissions", () => {
  test("a viewer reads the room and cannot write to it", async () => {
    const human = await join_("perm", ADA);
    await human.edit((d, a) => d.append("# Secret plan\n\nDo not change.", a));
    const viewer = await join_("perm", VIEWER);
    await until(() => viewer.doc.toMarkdown().includes("Do not change."), "the viewer to read");
    await expect(viewer.edit((d, a) => d.append("vandalism", a))).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A modified client skips the check above. The room still drops its update.
    const raw = await SyncClient.connect({ url: `${SERVER().replace("http", "ws")}/api/v1/docs/perm/ws`, headers: { authorization: `Bearer ${VIEWER}` } });
    await raw.edit((d) => d.getXmlFragment("default").delete(0, 1));
    expect(raw.denied.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(human.doc.toMarkdown()).toContain("Do not change.");
    expect(human.doc.toMarkdown()).not.toContain("vandalism");
    const fresh = await join_("perm", ADA);
    expect(fresh.doc.toMarkdown()).toBe(human.doc.toMarkdown());
    await Promise.all([human.leave(), viewer.leave(), raw.disconnect(), fresh.leave()]);
  });

  test("a viewer token cannot change a document over HTTP either, and an unknown token cannot join", async () => {
    const write = await fetch(`${SERVER()}/api/v1/docs/perm/append`, { method: "POST", headers: { authorization: `Bearer ${VIEWER}`, "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) });
    expect([write.status, ((await write.json()) as any).error.code]).toEqual([403, "FORBIDDEN"]);
    await expect(join_("perm", NOBODY)).rejects.toBeInstanceOf(DocError);
    const ws = await fetch(`${SERVER()}/api/v1/docs/perm/ws`);
    expect(ws.status).toBe(401);
  });

  test("a Worker built with no live rooms answers 404 on the ws route", async () => {
    const { createApp } = await import("./worker.js");
    const app = createApp({} as never);
    const res = await app.request("/api/v1/docs/a/ws", { headers: { authorization: `Bearer ${ADA}`, upgrade: "websocket" } }, { AGENTIC_DOCS_TOKENS: JSON.stringify(TOKENS) });
    expect(res.status).toBe(404);
  });
});

