// End to end: the real CLI binary and the real MCP server join live rooms on a Worker under `wrangler dev`. Needs `npm run build`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LiveDoc } from "./live.js";
import { liveServer, type LiveServer } from "./test-server.js";

const BIN = resolve("dist/cli.js");
const ADA = `ada-${"a".repeat(40)}`;
const BOT = `bot-${"b".repeat(40)}`;
const VIEWER = `viewer-${"v".repeat(40)}`;
const ROBOT = `robot-${"r".repeat(40)}`;
const TOKENS = { [ADA]: "human:Ada", [BOT]: "agent_of_human:scribe", [VIEWER]: { as: "human:Vic", role: "viewer" }, [ROBOT]: { as: "agent:robot", scopes: ["docs:admin"] } };

let server: LiveServer;
beforeAll(async () => {
  server = await liveServer(TOKENS);
  await server.start();
}, 90_000);
afterAll(() => server.dispose());

function cli(args: string[], token: string | undefined = BOT) {
  const env: Record<string, string | undefined> = { ...process.env, AGENTIC_DOCS_AS: undefined, AGENTIC_DOCS_TOKEN: token };
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, [BIN, ...args, "--live", server.url], { env: env as NodeJS.ProcessEnv });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code, out, err }));
  });
}
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  if (!check()) throw new Error(`timed out waiting for ${what}`);
};

describe("sharing from the CLI and the MCP server in live mode", { timeout: 30_000 }, () => {
  test("the owner shares through the server, and others get FORBIDDEN", async () => {
    expect((await cli(["new", "share-live", "--markdown", "# S"], ADA)).code).toBe(0);
    expect((await cli(["grant", "share-live", "--to", "agent:robot", "--role", "viewer"], ADA)).code).toBe(0);
    const grants = JSON.parse((await cli(["grants", "share-live"], ADA)).out) as { subjectId: string; role: string }[];
    expect(grants.map((g) => `${g.subjectId}:${g.role}`).sort()).toEqual(["Ada:owner", "robot:viewer"]);
    expect((await cli(["invite", "share-live", "--role", "viewer", "--email", "kit@example.com"], ADA)).code).toBe(0);
    const link = JSON.parse((await cli(["link", "share-live", "--role", "viewer"], ADA)).out) as { id: string; token: string };
    expect(link.token).toBeTruthy();
    expect((await cli(["unlink", "share-live", "--link", link.id], ADA)).code).toBe(0);
    expect((await cli(["revoke", "share-live", "--to", "agent:robot"], ADA)).code).toBe(0);

    for (const token of [BOT, VIEWER, ROBOT]) {
      expect((await cli(["grants", "share-live"], token)).err).toContain("FORBIDDEN");
      expect((await cli(["grant", "share-live", "--to", "agent:robot", "--role", "owner"], token)).err).toContain("FORBIDDEN");
    }
    expect(JSON.parse((await cli(["grants", "share-live"], ADA)).out)).toHaveLength(1);
  });

  test("the MCP server in live mode shares as the token's author", async () => {
    expect((await cli(["new", "mcp-foreign", "--markdown", "# F"], ADA)).code).toBe(0); // a document that robot does not own
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", "--live", server.url], env: { ...process.env, AGENTIC_DOCS_TOKEN: ROBOT } as Record<string, string> }));
    try {
      const made = (await client.callTool({ name: "doc_new", arguments: { id: "robot-doc", markdown: "# R" } })) as { isError?: boolean };
      expect(made.isError).toBeFalsy();
      const grant = (await client.callTool({ name: "doc_grant", arguments: { id: "robot-doc", to: "human:kit", role: "editor" } })) as { isError?: boolean };
      expect(grant.isError).toBeFalsy();
      const refused = (await client.callTool({ name: "doc_grants", arguments: { id: "mcp-foreign" } })) as { isError?: boolean; content: { text: string }[] };
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0].text).error.code).toBe("FORBIDDEN");
    } finally {
      await client.close();
    }
  });
});

describe("the CLI in a live room", () => {
  test("list, rename, and remove go to the server's catalog", async () => {
    expect((await cli(["new", "cat-cli", "--markdown", "# Catalog"])).code).toBe(0);
    expect((await cli(["rename", "cat-cli", "--title", "From the CLI"])).code).toBe(0);
    const listed = JSON.parse((await cli(["list"])).out) as { id: string; title: string }[];
    expect(listed.find((r) => r.id === "cat-cli")?.title).toBe("From the CLI");
    expect((await cli(["remove", "cat-cli"])).err).toContain("FORBIDDEN"); // an agent has no docs:remove scope
    expect((await cli(["remove", "cat-cli"], ADA)).code).toBe(0);
    expect(JSON.parse((await cli(["list"])).out).map((r: { id: string }) => r.id)).not.toContain("cat-cli");
  });

  test("an agent edits while a person is in the room, and both see the change", async () => {
    expect((await cli(["new", "shared", "--markdown", "# Plan\n\nShip on Friday."])).code).toBe(0);
    const human = await LiveDoc.join({ server: server.url, id: "shared", token: ADA });
    await until(() => human.doc.toMarkdown().includes("Ship on Friday"), "the human to read the plan");

    const [agent] = await Promise.all([
      cli(["replace", "shared", "--text", "Friday", "--content", "Monday"]),
      human.edit((d, a) => d.append("Human note.", a)),
    ]);
    expect(agent.code).toBe(0);
    await until(() => human.doc.toMarkdown().includes("Monday"), "the human to see the agent edit");
    expect(human.doc.toMarkdown()).toContain("Human note.");

    // The agent's read joins a fresh room client. It sees both edits, and its log names the agent kind.
    const read = await cli(["read", "shared"]);
    expect(read.out).toContain("Ship on Monday.");
    // The change is in the stored document too, not only in the room.
    const stored = await fetch(`${server.url}/api/v1/docs/shared/read`, { headers: { authorization: `Bearer ${ADA}` } });
    expect(await stored.text()).toContain("Ship on Monday.");
    expect(read.out).toContain("Human note.");
    const edits = JSON.parse((await cli(["edits", "shared"])).out) as { op: string; author: { kind: string } }[];
    expect(edits.find((e) => e.op === "replace")?.author.kind).toBe("agent_of_human");
    await human.leave();
  });

  test("a viewer token fails with FORBIDDEN and the text stays", async () => {
    await cli(["new", "guarded", "--markdown", "Keep this."]);
    const run = await cli(["append", "guarded", "--content", "vandalism"], VIEWER);
    expect(run.code).toBe(1);
    expect(run.err).toContain("FORBIDDEN");
    expect((await cli(["read", "guarded"], VIEWER)).out.trim()).toBe("Keep this.");
  });

  test("a missing document, a missing token, a bad token, and --as are refused", async () => {
    expect((await cli(["read", "ghost"])).err).toContain("NO_DOCUMENT");
    expect((await cli(["read", "ghost"], "")).code).toBe(2);
    const bad = await cli(["read", "ghost"], `nope-${"x".repeat(40)}`);
    expect([bad.code, bad.err]).toEqual([1, expect.stringContaining("FORBIDDEN")]);
    for (const flags of [["--as", "human:Ada"], ["--scopes", "docs:accept"], ["--dir", "/tmp/elsewhere"]]) {
      const run = await cli(["read", "shared", ...flags]);
      expect([run.code, run.err]).toEqual([2, expect.stringContaining("do not apply with --live")]);
    }
  });

  test("an empty or bad --live address never falls back to local files", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agentic-documents-cwd-"));
    const run = (live: string) => spawnSync(process.execPath, [BIN, "append", "plan", "--content", "x", "--live", live], { cwd, encoding: "utf8", env: { ...process.env, AGENTIC_DOCS_AS: "agent:bot", AGENTIC_DOCS_TOKEN: BOT } });
    for (const live of ["", "ftp://x", "docs.example.com"]) {
      const result = run(live);
      expect([result.status, result.stdout]).toEqual([2, ""]);
    }
    expect(existsSync(join(cwd, ".agentic-documents"))).toBe(false);
    const down = spawnSync(process.execPath, [BIN, "read", "plan", "--live", "http://127.0.0.1:1"], { cwd, encoding: "utf8", env: { ...process.env, AGENTIC_DOCS_TOKEN: BOT } });
    expect([down.status, down.stderr]).toEqual([1, expect.stringContaining("MISCONFIGURED: could not reach the live server")]);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("the MCP server in a live room", () => {
  test("tools run in the room as the token's author, and a viewer gets isError", async () => {
    const connect = async (token: string) => {
      const env = { ...process.env, AGENTIC_DOCS_TOKEN: token } as Record<string, string>;
      delete env.AGENTIC_DOCS_AS;
      const client = new Client({ name: "probe", version: "0.0.0" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", "--live", server.url], env }));
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0].text, isError: result.isError === true };
    };
    const agent = await connect(BOT);
    const viewer = await connect(VIEWER);
    try {
      expect((await call(agent, "doc_new", { id: "viamcp", markdown: "# Notes\n\nFirst." })).isError).toBe(false);
      expect((await call(agent, "doc_append", { id: "viamcp", content: "Second." })).isError).toBe(false);
      const room = await LiveDoc.join({ server: server.url, id: "viamcp", token: ADA });
      expect(room.doc.toMarkdown()).toContain("Second.");
      expect(room.doc.edits().map((e) => e.author.kind)).toContain("agent_of_human");
      await room.leave();
      const refused = await call(viewer, "doc_append", { id: "viamcp", content: "vandalism" });
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.text).error.code).toBe("FORBIDDEN");
      expect((await call(viewer, "doc_read", { id: "viamcp" })).text).not.toContain("vandalism");
    } finally {
      await Promise.all([agent.close(), viewer.close()]);
    }
  });
});
