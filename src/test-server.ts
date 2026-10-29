// Test helper: the Worker with live rooms under `wrangler dev`, with state that survives a restart.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const freePort = () =>
  new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });

export interface LiveServer {
  url: string;
  start(): Promise<void>;
  /** Kills the Worker. The state on disk stays, so `start` brings the rooms and documents back. */
  stop(): void;
  dispose(): void;
}

/** `assets` is a folder of static files that the Worker serves, such as the built web UI. */
export async function liveServer(tokens: object, options: { assets?: string } = {}): Promise<LiveServer> {
  const dir = mkdtempSync(join(tmpdir(), "agentic-documents-live-"));
  const port = await freePort();
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
      ...(options.assets ? { assets: { directory: resolve(options.assets) } } : {}),
      vars: { AGENTIC_DOCS_TOKENS: JSON.stringify(tokens), AGENTIC_DOCS_REGION: "unknown", AGENTIC_DOCS_UNSAFE_REGION: "1" },
    }),
  );
  const url = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  const stop = () => {
    if (server?.pid) process.kill(-server.pid, "SIGKILL");
    server = undefined;
  };
  return {
    url,
    stop,
    async start() {
      const inspector = await freePort();
      // Its own process group: workerd children outlive a kill of wrangler alone.
      server = spawn(resolve("node_modules/.bin/wrangler"), ["dev", "--config", join(dir, "wrangler.jsonc"), "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--local", "--persist-to", join(dir, "state")], {
        cwd: dir,
        detached: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk: Buffer) => (output += chunk));
      for (let i = 0; i < 120; i++) {
        if ((await fetch(`${url}/health`).catch(() => undefined))?.ok) return;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`wrangler dev did not start:\n${output.slice(-1500)}`);
    },
    dispose() {
      stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
