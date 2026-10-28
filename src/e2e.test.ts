// End to end: the real CLI binary and the real MCP server over stdio. Needs `npm run build`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const BIN = resolve("dist/cli.js");
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-documents-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ADA = "human:Ada";
const BOT = "agent_of_human:scribe";

function cli(args: string[], as: string | null = BOT) {
  const env: Record<string, string | undefined> = { ...process.env, AGENTIC_DOCS_DIR: dir, AGENTIC_DOCS_AS: as ?? undefined };
  const run = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
  return { code: run.status, out: run.stdout, err: run.stderr };
}
const json = (args: string[], as?: string) => JSON.parse(cli(args, as).out);

describe("cli failures", () => {
  test("a change without an author fails and writes nothing", () => {
    const run = cli(["new", "noauthor", "--markdown", "x"], null);
    expect(run.code).toBe(1);
    expect(run.err).toContain("INVALID_AUTHOR");
    expect(existsSync(join(dir, "noauthor.ydoc"))).toBe(false);
  });

  test("an unknown author kind fails", () => {
    expect(cli(["new", "badkind", "--markdown", "x"], "robot:r2").err).toContain("INVALID_AUTHOR");
  });

  test("an id that climbs out of the directory is refused", () => {
    const run = cli(["new", "../evil", "--markdown", "x"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("invalid document id");
    expect(existsSync(join(dir, "..", "evil.ydoc"))).toBe(false);
  });

  test("a missing document, a repeated new, and an unknown command fail", () => {
    expect(cli(["read", "ghost"]).err).toContain("NO_DOCUMENT");
    expect(cli(["new", "twice"]).code).toBe(0);
    expect(cli(["new", "twice"]).err).toContain("DOCUMENT_EXISTS");
    expect(cli(["frobnicate", "x"]).code).toBe(2);
  });

  test("a flag the command does not take is refused, not ignored", () => {
    cli(["new", "strict", "--markdown", "# A"]);
    const run = cli(["outline", "strict", "--text", "A"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("INVALID_INPUT");
  });

  test("an ambiguous match exits 1 and prints each context", () => {
    cli(["new", "amb", "--markdown", "one cat\n\ntwo cat"]);
    const run = cli(["replace", "amb", "--text", "cat", "--content", "dog"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("AMBIGUOUS_MATCH");
    expect(run.err).toMatch(/1: .*one cat/);
    expect(run.err).toMatch(/2: .*two cat/);
    expect(cli(["read", "amb"]).out).toContain("one cat");
  });
});

describe("cli flow", () => {
  test("write, review, and export a document across separate processes", () => {
    writeFileSync(join(dir, "seed.md"), "# Plan\n\nShip on Friday.\n\n## Risks\n\nNone yet.\n");
    expect(json(["new", "plan", "--file", join(dir, "seed.md")])).toEqual({ id: "plan" });
    const [plan, risks] = json(["outline", "plan"]);
    expect([plan.title, risks.title]).toEqual(["Plan", "Risks"]);

    cli(["replace", "plan", "--section", risks.id, "--content", "Two risks."]);
    cli(["insert", "plan", "--text", "Friday", "--at", "after", "--content", " morning"]);
    expect(cli(["append", "plan", "--content", "- [ ] write notes"]).code).toBe(0); // a value that starts with "-"
    const suggestion = json(["suggest", "plan", "--text", "Friday", "--replacement", "Monday"]).suggestion;
    expect(cli(["read", "plan"]).out).toContain("Friday morning");
    expect(cli(["accept", "plan", "--suggestion", suggestion], ADA).code).toBe(0);
    const thread = json(["comment", "plan", "--text", "Two risks.", "--body", "Which two?"]).thread;
    cli(["reply", "plan", "--thread", thread, "--body", "Cost and time."], ADA);
    cli(["resolve", "plan", "--thread", thread], ADA);

    const md = cli(["read", "plan"]).out;
    expect(md).toContain("Ship on Monday morning.");
    expect(md).toContain("- [ ] write notes");
    expect(cli(["read", "plan", "--section", risks.id]).out).toBe("## Risks\n\nTwo risks.\n\n- [ ] write notes\n");
    expect(json(["threads", "plan", "--status", "resolved"])[0].messages.map((m: { author: { kind: string } }) => m.author.kind)).toEqual([
      "agent_of_human",
      "human",
    ]);
    const log = json(["edits", "plan"]);
    expect(log.map((e: { author: { kind: string } }) => e.author.kind)).toContain("agent_of_human");
    expect(log.at(-1)).toMatchObject({ op: "replace", author: { kind: "human" }, suggestion: { author: { kind: "agent_of_human" } } });
    expect(JSON.stringify(log)).not.toContain("Cost and time");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("export writes Markdown to stdout or to a file", () => {
    cli(["new", "page", "--markdown", "# Hi\n\ntext"]);
    expect(cli(["export", "page", "--format", "md"]).out).toBe("# Hi\n\ntext\n");
    const out = join(dir, "page.md");
    expect(cli(["export", "page", "--format", "md", "--out", out]).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("# Hi\n\ntext\n");
    expect(cli(["export", "page", "--format", "pdf"]).code).toBe(2);
  });
});

describe("mcp over stdio", () => {
  async function connect(as?: string) {
    const env = { ...process.env } as Record<string, string>;
    delete env.AGENTIC_DOCS_AS;
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp", "--dir", dir, ...(as ? ["--as", as] : [])], env });
    const client = new Client({ name: "probe", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0].text, isError: result.isError === true };
  };

  test("lists one tool per command and takes no author argument", async () => {
    const client = await connect(BOT);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["doc_new", "doc_read", "doc_outline", "doc_insert", "doc_replace", "doc_suggest", "doc_comment", "doc_export"]));
      for (const tool of tools) expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("author");
    } finally {
      await client.close();
    }
  });

  test("an agent edits, and the log labels its work", async () => {
    const client = await connect(BOT);
    try {
      expect((await call(client, "doc_new", { id: "mcpdoc", markdown: "Hello world" })).isError).toBe(false);
      expect((await call(client, "doc_replace", { id: "mcpdoc", text: "world", content: "moon" })).isError).toBe(false);
      expect((await call(client, "doc_read", { id: "mcpdoc" })).text).toBe("Hello moon\n");
      const log = JSON.parse((await call(client, "doc_edits", { id: "mcpdoc" })).text);
      expect(log.map((e: { author: unknown }) => e.author)).toEqual([
        { kind: "agent_of_human", name: "scribe" },
        { kind: "agent_of_human", name: "scribe" },
      ]);
    } finally {
      await client.close();
    }
  });

  test("errors come back as isError with a code, and a server without an author cannot write", async () => {
    const client = await connect(BOT);
    try {
      await call(client, "doc_new", { id: "mcpamb", markdown: "a cat\n\nb cat" });
      const bad = await call(client, "doc_replace", { id: "mcpamb", text: "cat", content: "dog" });
      expect(bad.isError).toBe(true);
      expect(JSON.parse(bad.text).error).toMatchObject({ code: "AMBIGUOUS_MATCH", matches: [{ occurrence: 1 }, { occurrence: 2 }] });
    } finally {
      await client.close();
    }
    const anonymous = await connect();
    try {
      const refused = await call(anonymous, "doc_append", { id: "mcpamb", content: "x" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("INVALID_AUTHOR");
      expect((await call(anonymous, "doc_read", { id: "mcpamb" })).isError).toBe(false);
    } finally {
      await anonymous.close();
    }
  });
});
