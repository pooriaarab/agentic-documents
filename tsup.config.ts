import { defineConfig } from "tsup";

// `npm run build` empties dist first. The two builds write side by side.
export default defineConfig([
  {
    // Named entries, so `ui/entry.ts` lands next to the others as `dist/embed.js`.
    entry: {
      index: "src/index.ts",
      account: "src/account.ts",
      cli: "src/cli.ts",
      worker: "src/worker.ts",
      live: "src/live.ts",
      "live-worker": "src/live-worker.ts",
      formats: "src/formats.ts",
      embed: "ui/entry.ts",
    },
    format: ["esm"],
    dts: true,
  },
  {
    // The client is its own build, so it shares no chunk with the UI and imports nothing at run time.
    entry: { client: "src/client.ts" },
    format: ["esm"],
    dts: true,
  },
]);
