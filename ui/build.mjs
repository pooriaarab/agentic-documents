// Bundles the web UI into dist/ui. The Worker serves that folder as static assets.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist/ui", { recursive: true, force: true });
mkdirSync("dist/ui", { recursive: true });
await build({
  entryPoints: { app: "ui/main.tsx" },
  outdir: "dist/ui",
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  loader: { ".woff2": "file" },
  assetNames: "assets/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
cpSync("ui/index.html", "dist/ui/index.html");
