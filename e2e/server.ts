import { liveServer } from "../src/test-server.js";
import { TOKENS } from "./tokens.js";

// Starts `wrangler dev` with the built UI as static assets. Run `npm run build` first.
export default async function setup(): Promise<() => void> {
  const server = await liveServer(TOKENS, { assets: "dist/ui" });
  await server.start();
  process.env.E2E_URL = server.url;
  return () => server.dispose();
}
