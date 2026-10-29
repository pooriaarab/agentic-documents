import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/worker.ts", "src/live.ts", "src/live-worker.ts", "src/client.ts", "src/formats.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
