import { defineConfig } from "@playwright/test";

// One Worker serves the API, the live rooms, and the built UI. globalSetup starts it under `wrangler dev`.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/server.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { browserName: "chromium", trace: "retain-on-failure" },
});
