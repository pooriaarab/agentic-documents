#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createFileBlobs } from "./adapters/file-blobs.js";
import { createFileStore } from "./adapters/file-store.js";
import { commands } from "./commands.js";
import { DocError, parseAuthor } from "./doc.js";
import type { ExportResult } from "./export.js";
import { LiveService, whoAmI } from "./live.js";
import { DocsService, type DocAccess } from "./service.js";
import { VERSION } from "./version.js";

const NAME = "agentic-documents";
const flagNames = [...new Set(commands.flatMap((c) => Object.keys(c.shape)))].filter((k) => k !== "id");
const options = {
  ...Object.fromEntries(flagNames.map((k) => [k, { type: "string" as const }])),
  as: { type: "string" as const },
  scopes: { type: "string" as const },
  dir: { type: "string" as const },
  live: { type: "string" as const },
  file: { type: "string" as const },
  out: { type: "string" as const },
  help: { type: "boolean" as const, short: "h" },
  version: { type: "boolean" as const, short: "V" },
};

function help(): string {
  const lines = commands.map((c) => `  ${c.name.padEnd(12)}${c.description}`);
  return [
    `${NAME} ${VERSION}`,
    "",
    `Usage: ${NAME} <command> <id> [flags]`,
    "",
    "Commands:",
    ...lines,
    "  mcp         Start the MCP server on stdio.",
    "",
    "Flags:",
    "  --as <kind:name>  Who makes the change. Or set AGENTIC_DOCS_AS. Kinds: human, agent_of_human,",
    "                    agent_of_agent, agent, user_token.",
    "  --scopes <a,b>    Rights for the author, such as docs:accept. Or set AGENTIC_DOCS_SCOPES. An agent",
    "                    needs docs:accept to accept a suggestion.",
    "  --live <url>      Join live rooms on this server, as the author of AGENTIC_DOCS_TOKEN. Or set",
    "                    AGENTIC_DOCS_LIVE_URL. The server sets your author kind, so --as, --scopes, and --dir are refused.",
    "  --dir <path>      Where documents live. Or set AGENTIC_DOCS_DIR. Default: .agentic-documents",
    "  --file <path>     Read content (or markdown for new) from a file.",
    "  --out <path>      Write the export to a file.",
    "  --<field> <value> Any field of the command, such as --text, --section, --occurrence.",
  ].join("\n");
}

// parseArgs refuses a value that starts with "-", such as a Markdown list. Bind each value to its flag.
function bindValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith("--") && !argv[i].includes("=") ? argv[i].slice(2) : undefined;
    const takesValue = name !== undefined && (options as Record<string, { type: string }>)[name]?.type === "string";
    out.push(takesValue && i + 1 < argv.length ? `${argv[i]}=${argv[++i]}` : argv[i]);
  }
  return out;
}

export async function main(argv: string[], env = process.env): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: bindValues(argv), options, allowPositionals: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const { values, positionals } = parsed;
  const [name, id] = positionals;
  if (values.version || values.help || name === undefined) {
    console.log(values.version ? VERSION : help());
    return 0;
  }

  // An explicit flag never falls back to local mode. An empty AGENTIC_DOCS_LIVE_URL means "not set".
  const liveUrl = values.live ?? (env.AGENTIC_DOCS_LIVE_URL || undefined);
  let service: DocAccess;
  let author;
  if (liveUrl !== undefined) {
    if (!/^https?:\/\/[^/\s]+/.test(liveUrl)) {
      console.error(`--live needs an http:// or https:// address, not "${liveUrl}"`);
      return 2;
    }
    if (values.as !== undefined || values.scopes !== undefined || values.dir !== undefined) {
      console.error("--as, --scopes, and --dir do not apply with --live: the server sets the author kind and the scopes from the token, and keeps the documents.");
      return 2;
    }
    const token = env.AGENTIC_DOCS_TOKEN;
    if (!token) {
      console.error("set AGENTIC_DOCS_TOKEN to a bearer token to join a live room");
      return 2;
    }
    try {
      author = (await whoAmI(liveUrl, token)).author;
    } catch (error) {
      if (!(error instanceof DocError)) throw error;
      console.error(`${error.code}: ${error.message}`);
      return 1;
    }
    service = new LiveService({ server: liveUrl, token });
  } else {
    const dir = values.dir ?? env.AGENTIC_DOCS_DIR ?? ".agentic-documents";
    service = new DocsService({ blobs: createFileBlobs(join(dir, "blobs")), store: createFileStore(join(dir, "store")) });
    const scopes = (values.scopes ?? env.AGENTIC_DOCS_SCOPES)?.split(",").map((s) => s.trim()).filter(Boolean);
    const named = parseAuthor(values.as ?? env.AGENTIC_DOCS_AS);
    author = named && scopes?.length ? { ...named, scopes } : named;
  }
  if (name === "mcp") {
    const { startMcp } = await import("./mcp.js");
    await startMcp(service, author);
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) {
    console.error(`unknown command "${name}". Run "${NAME} --help".`);
    return 2;
  }
  const { as: _as, scopes: _scopes, dir: _dir, live: _live, file, out, help: _help, version: _version, ...fields } = values;
  const input: Record<string, unknown> = { ...(command.shape.id ? { id } : {}), ...fields };
  try {
    if (file !== undefined) {
      const key = "content" in command.shape ? "content" : "markdown" in command.shape ? "markdown" : undefined;
      if (!key) throw new DocError("INVALID_INPUT", `"${name}" takes no --file`);
      if (key in input) throw new DocError("INVALID_INPUT", `pass --file or --${key}, not both`);
      input[key] = readFileSync(file, "utf8");
    }
    const result = await command.run(service, input, author);
    if (name === "export") {
      const { data, encoding } = result as ExportResult;
      const bytes = encoding === "base64" ? Buffer.from(data, "base64") : data;
      if (out === undefined) process.stdout.write(bytes);
      else writeFileSync(out, bytes);
    } else console.log(typeof result === "string" ? result.replace(/\n$/, "") : JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (!(error instanceof DocError)) throw error;
    console.error(`${error.code}: ${error.message}`);
    for (const m of error.matches) console.error(`  ${m.occurrence}: ...${m.context}...`);
    return error.code === "INVALID_INPUT" ? 2 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    // A running server (mcp) keeps stdio open, so exit only on failure.
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
