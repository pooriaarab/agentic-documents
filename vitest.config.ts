import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "ui/**/*.test.tsx"],
    environment: "node",
    testTimeout: 30_000, // the CLI tests start a process for each call, and a busy machine passes 5 s
  },
});
