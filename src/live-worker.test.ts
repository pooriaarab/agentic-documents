// The live Worker with a fake room server. The real one needs workerd, which cannot place rooms in a jurisdiction.
import { describe, expect, test, vi } from "vitest";

const placed: (string | undefined)[] = [];
vi.mock("agentic-realtime/worker", () => ({
  SyncRoom: class {},
  createDurableObjectRealtime: (_namespace: unknown, jurisdiction?: string) => {
    placed.push(jurisdiction);
    return {
      connect: async () => new Response("room", { status: 200 }),
      meta: async () => ({ updates: 0, compactions: 0, contributors: [] }),
    };
  },
}));

const TOKEN = `ada-${"a".repeat(40)}`;
const base = { AGENTIC_DOCS_UNSAFE_TOKENS: "1", AGENTIC_DOCS_TOKENS: JSON.stringify({ [TOKEN]: "human:Ada" }), SYNC_ROOM: {} };
const ask = async (path: string, env: object) => {
  const { default: worker } = await import("./live-worker.js");
  const headers = { authorization: `Bearer ${TOKEN}`, upgrade: "websocket" };
  const res = await worker.fetch(new Request(`http://x${path}`, { headers }), { ...base, ...env } as never, {});
  return [res.status, res.headers.get("content-type")?.includes("json") ? ((await res.json()) as any).error?.code : undefined] as const;
};

describe("live Worker config", () => {
  test("a missing or bad region refuses the ws route and the room list", async () => {
    for (const env of [{}, { AGENTIC_DOCS_REGION: "EU" }, { AGENTIC_DOCS_REGION: "unknown" }]) {
      for (const path of ["/api/v1/docs/a/ws", "/api/v1/docs/a/room"]) expect(await ask(path, env)).toEqual([500, "MISCONFIGURED"]);
    }
    expect(placed).toEqual([]);
  });

  test("the eu region puts rooms in the eu jurisdiction, and a missing namespace is refused", async () => {
    expect((await ask("/api/v1/docs/a/ws", { AGENTIC_DOCS_REGION: "eu" }))[0]).toBe(200);
    expect(placed).toEqual(["eu"]);
    expect((await ask("/api/v1/docs/a/room", { AGENTIC_DOCS_REGION: "us" }))[0]).toBe(200);
    expect(placed).toEqual(["eu", undefined]);
    expect(await ask("/api/v1/docs/a/ws", { AGENTIC_DOCS_REGION: "eu", SYNC_ROOM: undefined })).toEqual([500, "MISCONFIGURED"]);
  });
});
