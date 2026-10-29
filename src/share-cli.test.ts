// End to end: sharing through the real CLI binary and the real MCP server over stdio, on one local directory. Needs `npm run build`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const BIN = resolve("dist/cli.js");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-documents-share-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ADA = "human:ada";
const BEA = "human:bea";
const BOT = "agent:robot";

function cli(args: string[], as: string, scopes?: string) {
  const env: Record<string, string | undefined> = { ...process.env, AGENTIC_DOCS_DIR: dir, AGENTIC_DOCS_AS: as, AGENTIC_DOCS_SCOPES: scopes };
  const run = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

describe("sharing in the CLI", { timeout: 30_000 }, () => {
  test("the owner grants, lists, invites, links, and revokes", () => {
    expect(cli(["new", "plan", "--markdown", "# Plan"], ADA).code).toBe(0);
    expect(cli(["grant", "plan", "--to", "human:kit", "--role", "editor"], ADA).code).toBe(0);
    const grants = JSON.parse(cli(["grants", "plan"], ADA).out) as { subjectId: string; role: string }[];
    expect(grants.map((g) => `${g.subjectId}:${g.role}`).sort()).toEqual(["ada:owner", "kit:editor"]);
    expect(cli(["revoke", "plan", "--to", "human:kit"], ADA).code).toBe(0);
    expect(JSON.parse(cli(["grants", "plan"], ADA).out)).toHaveLength(1);

    const invite = cli(["invite", "plan", "--role", "viewer", "--email", "kit@example.com"], ADA);
    expect(invite.code).toBe(0);
    expect(JSON.parse(cli(["invites", "plan"], ADA).out)).toHaveLength(1);
    expect(cli(["invites", "plan"], ADA).out).not.toContain("example.com");

    const link = JSON.parse(cli(["link", "plan", "--role", "viewer", "--signedInOnly", "true"], ADA).out) as { id: string; token: string };
    expect(link.token).toBeTruthy();
    expect(cli(["unlink", "plan", "--link", link.id], ADA).code).toBe(0);
  });

  test("another person, and an agent that tries to grant itself, get FORBIDDEN and exit 1", () => {
    expect(cli(["grant", "plan", "--to", "human:bea", "--role", "owner"], BEA)).toMatchObject({ code: 1, err: expect.stringContaining("FORBIDDEN") });
    expect(cli(["grants", "plan"], BEA).err).toContain("FORBIDDEN");
    expect(cli(["grant", "plan", "--to", "agent:robot", "--role", "owner"], BOT, "docs:admin").err).toContain("FORBIDDEN");
    expect(cli(["link", "plan", "--role", "viewer"], BOT).err).toContain("FORBIDDEN");
    expect(JSON.parse(cli(["grants", "plan"], ADA).out).map((g: { subjectId: string }) => g.subjectId)).toEqual(["ada"]);
  });

  test("an agent without the admin scope cannot share what it owns", () => {
    expect(cli(["new", "mine", "--markdown", "# Mine"], BOT, "docs:write").code).toBe(0);
    expect(cli(["grants", "mine"], BOT, "docs:write").err).toContain("FORBIDDEN");
    expect(cli(["grants", "mine"], BOT, "docs:admin").code).toBe(0);
  });

  test("a bad role or a missing author is an input error", () => {
    expect(cli(["grant", "plan", "--to", "human:kit", "--role", "boss"], ADA).code).toBe(2);
    expect(cli(["grant", "plan", "--to", "kit", "--role", "viewer"], ADA).code).toBe(2);
    expect(cli(["grants", "plan"], "").err).toContain("INVALID_AUTHOR");
  });
});

describe("sharing in the MCP server", () => {
  async function connect(as: string) {
    const env = { ...process.env, AGENTIC_DOCS_AS: undefined } as unknown as Record<string, string>;
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", "--dir", dir, "--as", as], env }));
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0].text, isError: result.isError === true };
  };

  test("the tools exist, and the author is fixed by the operator", async () => {
    const owner = await connect(ADA);
    const other = await connect(BEA);
    try {
      const names = (await owner.listTools()).tools.map((t) => t.name);
      for (const name of ["doc_grants", "doc_grant", "doc_revoke", "doc_invites", "doc_invite", "doc_link", "doc_unlink"]) expect(names).toContain(name);
      expect((await call(owner, "doc_new", { id: "mcpplan", markdown: "# P" })).isError).toBe(false);
      expect((await call(owner, "doc_grant", { id: "mcpplan", to: "human:kit", role: "commenter" })).isError).toBe(false);
      expect(JSON.parse((await call(owner, "doc_grants", { id: "mcpplan" })).text)).toHaveLength(2);
      const link = await call(owner, "doc_link", { id: "mcpplan", role: "viewer" });
      expect(JSON.parse(link.text).token).toBeTruthy();

      const refused = await call(other, "doc_grant", { id: "mcpplan", to: "human:bea", role: "owner" });
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.text).error.code).toBe("FORBIDDEN");
      // The tool takes no author field, so a call cannot claim to be the owner.
      await expect(call(other, "doc_grant", { id: "mcpplan", to: "human:bea", role: "owner", as: ADA })).resolves.toMatchObject({ isError: true });
    } finally {
      await Promise.all([owner.close(), other.close()]);
    }
  });
});
