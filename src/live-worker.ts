import { createDurableObjectRealtime } from "agentic-realtime/worker";
import { DocError } from "./doc.js";
import { createApp, regionOf, serviceFor, type WorkerEnv } from "./worker.js";

export { SyncRoom } from "agentic-realtime/worker";

type Namespace = Parameters<typeof createDurableObjectRealtime>[0];

export interface LiveEnv extends WorkerEnv {
  /** Durable Object namespace of the live rooms. Bind `SyncRoom` to it. */
  SYNC_ROOM?: Namespace;
}

/** The Worker with live rooms. It keeps each room in a Durable Object, in the EU jurisdiction when the region is "eu". Durable Objects have no US jurisdiction: with "us" a room sits near the first client that opens it. */
const app = createApp(serviceFor, {
  live: (env) => {
    const region = regionOf(env); // the same claim as the HTTP API: no valid region, no room
    const rooms = (env as LiveEnv).SYNC_ROOM;
    if (!rooms) throw new DocError("MISCONFIGURED", "bind a Durable Object namespace as SYNC_ROOM");
    return createDurableObjectRealtime(rooms, region === "eu" ? "eu" : undefined);
  },
});

export default { fetch: (request: Request, env: LiveEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
