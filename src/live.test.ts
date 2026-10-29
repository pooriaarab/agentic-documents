// End to end: the real Worker with live rooms under `wrangler dev`, and real LiveDoc clients.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SyncClient } from "agentic-realtime/client";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { AgenticDoc, DocError } from "./doc.js";
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
const http = (path: string, token: string, body?: unknown) =>
  fetch(`${SERVER()}/api/v1/docs${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

  test("an unknown token cannot open the room, and a raw editor can forge the log but not the room's list", async () => {
    await expect(SyncClient.connect({ url: `${SERVER().replace("http", "ws")}/api/v1/docs/perm/ws`, headers: { authorization: `Bearer ${NOBODY}` }, timeoutMs: 1500 })).rejects.toThrow();
    const agent = await join_("forged", BOT);
    await agent.edit((d, a) => d.append("Honest.", a));
    const raw = await SyncClient.connect({ url: `${SERVER().replace("http", "ws")}/api/v1/docs/forged/ws`, headers: { authorization: `Bearer ${BOT}` } });
    const forged = new AgenticDoc(raw.doc);
    await raw.edit(() => forged.append("Forged.", { kind: "human", name: "Ada" }));
    expect(forged.edits().map((e) => e.author.kind)).toContain("human");
    const room = (await (await http("/forged/room", ADA)).json()) as { contributors: { kind: string; machine: boolean }[] };
    expect(room.contributors).toEqual([expect.objectContaining({ name: "scribe", kind: "agent_of_human", machine: true })]);
    await Promise.all([agent.leave(), raw.disconnect()]);
  });

  test("a Worker built with no live rooms answers 404 on the ws route", async () => {
    const { createApp } = await import("./worker.js");
    const app = createApp({} as never);
    const res = await app.request("/api/v1/docs/a/ws", { headers: { authorization: `Bearer ${ADA}`, upgrade: "websocket" } }, { AGENTIC_DOCS_TOKENS: JSON.stringify(TOKENS) });
    expect(res.status).toBe(404);
  });
});


describe("config that fails closed", () => {
  test("a bad role refuses the whole token table", async () => {
    const { createApp } = await import("./worker.js");
    const app = createApp({} as never);
    for (const role of ["admin", "owner", 1, null]) {
      const env = { AGENTIC_DOCS_TOKENS: JSON.stringify({ [ADA]: { as: "human:Ada", role }, [BOT]: "agent:bot" }) };
      for (const token of [ADA, BOT]) expect((await app.request("/api/v1/me", { headers: { authorization: `Bearer ${token}` } }, env)).status).toBe(401);
    }
  });

});

describe("persistence through the Store and Blobs ports", () => {
  test("a room starts from the stored document, and a save lands in the store with the agent's label", async () => {
    expect((await http("", ADA, { id: "stored", markdown: "# Brief\n\nStart here." })).status).toBe(200);
    // Two clients join at once. Both seed the room. The text must appear once.
    const [human, agent] = await Promise.all([join_("stored", ADA), join_("stored", BOT)]);
    await until(() => human.doc.toMarkdown() === agent.doc.toMarkdown() && human.doc.toMarkdown().includes("Start here."), "both to read the brief");
    expect(human.doc.toMarkdown().match(/Start here/g)).toHaveLength(1);

    await agent.edit((d, a) => d.append("Agent paragraph.", a));
    await human.edit((d, a) => d.append("Human paragraph.", a));
    await until(() => agent.doc.toMarkdown().includes("Human paragraph."), "the agent to see the human");
    await agent.save();
    await human.save();

    const stored = await (await http("/stored/read", ADA)).text();
    expect(stored).toContain("Start here.");
    expect(stored).toContain("Agent paragraph.");
    expect(stored).toContain("Human paragraph.");
    const edits = (await (await http("/stored/edits", ADA)).json()) as { op: string; author: { kind: string; name: string } }[];
    expect(edits.filter((e) => e.op === "append").map((e) => `${e.author.kind}:${e.author.name}`).sort()).toEqual(["agent_of_human:scribe", "human:Ada"]);
    await Promise.all([human.leave(), agent.leave()]);
  });

  test("a save creates the document when the room has no stored copy, and a viewer cannot save", async () => {
    const agent = await join_("fresh", BOT);
    await agent.edit((d, a) => d.append("# Born live\n\nFrom a room.", a));
    await agent.save();
    expect(await (await http("/fresh/read", ADA)).text()).toContain("From a room.");
    const viewer = await join_("fresh", VIEWER);
    expect(viewer.doc.toMarkdown()).toContain("From a room.");
    expect(viewer.denied).toEqual([]);
    await expect(viewer.save()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const raw = await fetch(`${SERVER()}/api/v1/docs/fresh/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${VIEWER}` }, body: new Uint8Array() });
    expect(raw.status).toBe(403);
    await Promise.all([agent.leave(), viewer.leave()]);
  });

  test("a bad checkpoint is refused and the stored document stays", async () => {
    const bad = await fetch(`${SERVER()}/api/v1/docs/fresh/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${ADA}` }, body: new Uint8Array([255, 255, 255, 9, 9]) });
    expect(bad.status).toBe(400);
    expect(await (await http("/fresh/read", ADA)).text()).toContain("From a room.");
  });

  test("text written over HTTP keeps its author in the log, and the room list names only who sent updates in the room", async () => {
    await http("", BOT, { id: "http-made", markdown: "# Machine text\n\nWritten over HTTP." });
    const human = await join_("http-made", ADA);
    const log = human.doc.edits().map((e) => `${e.author.kind}:${e.author.name}`);
    expect(log).toEqual(["agent_of_human:scribe"]);
    const room = (await (await http("/http-made/room", ADA)).json()) as { contributors: { kind: string }[] };
    expect(room.contributors.map((c) => c.kind)).toEqual(["human"]); // the seeding client. The room never saw the agent.
    await human.leave();
  });

  test("an update over the size limit is refused, with or without a length header", async () => {
    const big = new Uint8Array(1_000_001);
    const sized = await fetch(`${SERVER()}/api/v1/docs/fresh/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${ADA}` }, body: big });
    expect([sized.status, ((await sized.json()) as any).error.message]).toEqual([400, expect.stringContaining("over 1000000 bytes")]);
    // A chunked body has no content-length. The server cuts it off at the cap.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(100_000));
        controller.close();
      },
    });
    const chunked = await fetch(`${SERVER()}/api/v1/docs/fresh/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${ADA}` }, body: stream, duplex: "half" } as RequestInit);
    expect([chunked.status, ((await chunked.json()) as any).error.message]).toEqual([400, expect.stringContaining("over 1000000 bytes")]);
  });

  test("a valid update with an empty body, an unknown root, or missing parts is refused", async () => {
    const post = (id: string, body: Uint8Array) => fetch(`${SERVER()}/api/v1/docs/${id}/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${ADA}` }, body: new Uint8Array(body) });
    const alien = new Y.Doc();
    alien.getText("evil").insert(0, "x");
    const later = new Y.Doc();
    later.getText("default").insert(0, "a");
    const mark = Y.encodeStateVector(later);
    later.getText("default").insert(1, "b");
    const cases: [Uint8Array, string][] = [
      [new Uint8Array([0, 0]), "empty or lacks"],
      [Y.encodeStateAsUpdate(alien), 'part this package does not use: "evil"'],
      [Y.encodeStateAsUpdate(later, mark), "empty or lacks"],
    ];
    for (const [body, why] of cases) {
      const res = await post("shape", body);
      expect([res.status, ((await res.json()) as any).error.message]).toEqual([400, expect.stringContaining(why)]);
    }
    expect((await http("/shape/read", ADA)).status).toBe(404);
  });

  test("an update with the wrong kind of content at a known root is refused and the document stays readable", async () => {
    await http("", ADA, { id: "typed", markdown: "# Typed\n\nStays." });
    const wrong = (build: (d: Y.Doc) => void) => {
      const d = new Y.Doc();
      build(d);
      return Y.encodeStateAsUpdate(d);
    };
    const bodies = [
      wrong((d) => d.getText("default").insert(0, "zz")),
      wrong((d) => d.getText("edits").insert(0, "zz")),
    ];
    const probe = async (id: string, body: Uint8Array) => {
      const res = await fetch(`${SERVER()}/api/v1/docs/${id}/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${BOT}` }, body: new Uint8Array(body) });
      return [res.status, ((await res.json().catch(() => ({}))) as any).error?.message ?? ""] as const;
    };
    for (const body of bodies) {
      // Onto an existing document, then as a new one.
      expect(await probe("typed", body)).toEqual([400, expect.stringContaining("unreadable")]);
      expect(await probe("typed-new", body)).toEqual([400, expect.stringContaining("unreadable")]);
    }
    expect(await (await http("/typed/read", ADA)).text()).toContain("Stays.");
    expect((await http("/typed-new/read", ADA)).status).toBe(404);
  });

  test("checkpoints from many clients at once all land", async () => {
    await http("", ADA, { id: "race", markdown: "# Race\n\nStart." });
    const base = new Uint8Array(await (await fetch(`${SERVER()}/api/v1/docs/race/state`, { headers: { authorization: `Bearer ${ADA}` } })).arrayBuffer());
    const sends = Array.from({ length: 6 }, (_, i) => {
      const replica = AgenticDoc.fromUpdate(base);
      replica.append(`Line ${i}.`, { kind: "agent_of_human", name: `w${i}` });
      return fetch(`${SERVER()}/api/v1/docs/race/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${BOT}` }, body: new Uint8Array(replica.encode()) });
    });
    for (const res of await Promise.all(sends)) expect(res.status).toBe(200);
    const text = await (await http("/race/read", ADA)).text();
    for (let i = 0; i < 6; i++) expect(text).toContain(`Line ${i}.`);
  });

  test("a saved log is client-written: an editor can post a forged author, so the log stays advisory", async () => {
    const base = new Uint8Array(await (await fetch(`${SERVER()}/api/v1/docs/race/state`, { headers: { authorization: `Bearer ${BOT}` } })).arrayBuffer());
    const forged = AgenticDoc.fromUpdate(base);
    forged.append("Forged.", { kind: "human", name: "Ada" });
    await fetch(`${SERVER()}/api/v1/docs/race/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${BOT}` }, body: new Uint8Array(forged.encode()) });
    const edits = (await (await http("/race/edits", ADA)).json()) as { author: { kind: string; name: string } }[];
    expect(edits.some((e) => e.author.kind === "human" && e.author.name === "Ada" && edits.length > 1)).toBe(true);
  });

  test("a stored document too big for a room fails the join with a clear error and leaves no client behind", async () => {
    await http("", ADA, { id: "huge", markdown: "# Huge" });
    expect((await http("/huge/append", ADA, { content: "x".repeat(1_200_000) })).status).toBe(200);
    const disconnect = vi.spyOn(SyncClient.prototype, "disconnect");
    await expect(join_("huge", ADA, { reconnect: { initialMs: 50, maxMs: 100 } })).rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("most a live room takes") });
    expect(disconnect).toHaveBeenCalledTimes(1);
    disconnect.mockRestore();
    const saved = await fetch(`${SERVER()}/api/v1/docs/huge/checkpoint`, { method: "POST", headers: { authorization: `Bearer ${ADA}` }, body: new Uint8Array(await (await fetch(`${SERVER()}/api/v1/docs/huge/state`, { headers: { authorization: `Bearer ${ADA}` } })).arrayBuffer()) });
    expect(saved.status).toBe(400);
  });
});
