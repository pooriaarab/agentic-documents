// Packed artifacts must round-trip the same files on each public surface.
// Failures: malformed encoding/archive, input caps, author spoofing, viewer writes,
// duplicate ids, missing authors, and content loss must never create a document.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import type * as Library from "./index.js";
import type * as Http from "./client.js";
import type * as Worker from "./worker.js";
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";

let dir: string;
let lib: typeof Library;
let http: typeof Http;
let worker: typeof Worker;
let bin: string;
const author = { kind: "agent", name: "scribe" } as const;
const markdown = "# Plan\n\nA **bold** word and a [link](https://example.com).\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "docs-packed-formats-"));
  const pack = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { encoding: "utf8" }))[0].filename;
  execFileSync("tar", ["-xzf", join(dir, pack), "-C", dir]);
  symlinkSync(resolve("node_modules"), join(dir, "package/node_modules"), "dir");
  const load = (name: string) => import(pathToFileURL(join(dir, "package/dist", name + ".js")).href);
  [lib, http, worker] = await Promise.all([load("index"), load("client"), load("worker")]);
  bin = join(dir, "package/dist/cli.js");
}, 90_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args, "--dir", join(dir, "store"), "--as", "agent:scribe"], { encoding: "utf8" });

for (const format of ["odt", "docx"] as const) test(`packed ${format} round-trip in SDK, HTTP, CLI and MCP`, async () => {
  const original = lib.AgenticDoc.fromMarkdown(markdown, author);
  const exported = lib.exportDoc(original, format);
  expect(exported.encoding).toBe("base64");
  const bytes = Buffer.from(exported.data, "base64");
  const formats = await import(pathToFileURL(join(dir, "package/dist/formats.js")).href);
  expect(formats.importFile(bytes, format, author).doc.toMarkdown()).toBe(original.toMarkdown());

  const token = "t".repeat(40), viewer = "v".repeat(40);
  const service = new lib.DocsService({ blobs: createMemoryBlobs(), store: createMemoryStore() });
  const app = worker.createApp(service);
  const env = { AGENTIC_DOCS_UNSAFE_TOKENS: "1", AGENTIC_DOCS_TOKENS: JSON.stringify({ [token]: "agent:scribe", [viewer]: { as: "human:Vic", role: "viewer" } }) };
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => app.request(url, init, env)) as typeof fetch;
  const client = http.createClient({ baseUrl: "http://docs", token, fetch: fetcher });
  const input = { format, encoding: "base64" as const, data: exported.data };
  expect(await client.import(format, input)).toEqual({ id: format, warnings: [] });
  expect(await client.read(format)).toBe(original.toMarkdown());
  expect(await client.export(format, { format })).toEqual(new Uint8Array(bytes));
  expect((await client.edits(format))[0].author).toMatchObject(author);
  await expect(client.import(format, input)).rejects.toMatchObject({ code: "DOCUMENT_EXISTS" });
  const readonly = http.createClient({ baseUrl: "http://docs", token: viewer, fetch: fetcher });
  await expect(readonly.import("denied", input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  for (const data of ["!", "AB==", "eA==", "A".repeat(4 * Math.ceil(8 * 1024 * 1024 / 3) + 4)]) {
    await expect(client.import("bad", { ...input, data })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
  const spoof = await app.request("http://docs/api/v1/docs/spoof/import", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ ...input, author: { kind: "human", name: "Ada" } }) }, env);
  expect(spoof.status).toBe(400);
  expect((await client.list()).map((d) => d.id)).toEqual([format]);

  const path = join(dir, `file.${format}`);
  writeFileSync(path, bytes);
  expect(cli("import", format, "--format", format, "--file", path).status).toBe(0);
  expect(cli("read", format).stdout).toBe(original.toMarkdown());
  const out = join(dir, `out.${format}`);
  expect(cli("export", format, "--format", format, "--out", out).status).toBe(0);
  expect(readFileSync(out)).toEqual(bytes);

  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, "mcp", "--dir", join(dir, "mcp"), "--as", "agent:scribe"], stderr: "pipe" });
  const mcp = new Client({ name: "format-test", version: "1" });
  await mcp.connect(transport);
  try {
    const call = async (name: string, args: object) => {
      const result = await mcp.callTool({ name: `doc_${name}`, arguments: args as Record<string, unknown> });
      expect(result.isError).not.toBe(true);
      return (result.content as { text: string }[])[0].text;
    };
    expect(JSON.parse(await call("import", { id: format, ...input }))).toEqual({ id: format, warnings: [] });
    expect(await call("read", { id: format })).toBe(original.toMarkdown());
    expect(JSON.parse(await call("export", { id: format, format }))).toEqual(exported);
    expect(JSON.parse(await call("edits", { id: format }))[0].author).toMatchObject(author);
    const bad = await mcp.callTool({ name: "doc_import", arguments: { id: "bad", ...input, data: "eA==" } });
    expect(bad.isError).toBe(true);
  } finally { await mcp.close(); }
}, 90_000);

test("packed import reports loss and refuses missing authors and oversized CLI files", async () => {
  const formats = await import(pathToFileURL(join(dir, "package/dist/formats.js")).href);
  const { writeDocx } = await import("agentic-formats");
  const file = writeDocx({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "marked", marks: ["underline"] }] }] }).bytes;
  expect(formats.importFile(file, "docx", author).warnings.length).toBeGreaterThan(0);
  const path = join(dir, "warning.docx");
  writeFileSync(path, file);
  expect(JSON.parse(cli("import", "warning", "--format", "docx", "--file", path).stdout).warnings.length).toBeGreaterThan(0);
  const noAuthor = spawnSync(process.execPath, [bin, "import", "no-author", "--format", "docx", "--file", path, "--dir", join(dir, "store")], { encoding: "utf8", env: { ...process.env, AGENTIC_DOCS_AS: "" } });
  expect(noAuthor.stderr).toContain("INVALID_AUTHOR");
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1));
  expect(cli("import", "oversize", "--format", "docx", "--file", path).stderr).toContain("INVALID_INPUT");
});


test("file imports keep multiple paragraphs inside table cells", async () => {
  const { writeDocx } = await import("agentic-formats");
  const file = writeDocx({ blocks: [{ type: "table", rows: [[[{ type: "paragraph", content: [{ type: "text", text: "first" }] }, { type: "paragraph", content: [{ type: "text", text: "second" }] }]]] }] }).bytes;
  const service = new lib.DocsService({ blobs: createMemoryBlobs(), store: createMemoryStore() });
  await service.import("rich", Buffer.from(file).toString("base64"), "docx", author);
  const blocks = await service.read("rich", (d) => d.toJSON());
  expect(blocks.content?.[0].content?.[0].content?.[0].content).toHaveLength(2);
});
