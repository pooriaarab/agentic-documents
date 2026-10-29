import { build } from "esbuild";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveServer } from "../src/test-server.js";
import { TOKENS } from "./tokens.js";

// Starts `wrangler dev` with the built UI as static assets. Run `npm run build` first.
// It also serves /embed/: a host page that mounts `agentic-documents/ui` from the build, as an app that embeds it would.
export default async function setup(): Promise<() => void> {
  const assets = mkdtempSync(join(tmpdir(), "agentic-documents-assets-"));
  cpSync("dist/ui", assets, { recursive: true });
  await build({
    entryPoints: { "embed/app": "e2e/embed/main.ts", "embed/mount": "e2e/embed/mount.ts" },
    outdir: assets,
    bundle: true,
    format: "esm",
    target: "es2022",
    loader: { ".woff2": "file" },
    assetNames: "embed/assets/[name]-[hash]",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  cpSync("e2e/embed/index.html", join(assets, "embed/index.html"));
  cpSync("e2e/embed/mount.html", join(assets, "embed/mount.html"));
  const server = await liveServer(TOKENS, { assets });
  await server.start();
  process.env.E2E_URL = server.url;
  return () => (server.dispose(), rmSync(assets, { recursive: true, force: true }));
}
