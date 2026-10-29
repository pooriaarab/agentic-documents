import { createDurableObjectRealtime } from "agentic-realtime/worker";
import { createApp, serviceFor, type WorkerEnv } from "./worker.js";

export { SyncRoom } from "agentic-realtime/worker";

type Namespace = Parameters<typeof createDurableObjectRealtime>[0];

export interface LiveEnv extends WorkerEnv {
  /** Durable Object namespace of the live rooms. Bind `SyncRoom` to it. */
  SYNC_ROOM?: Namespace;
}

/** The Worker with live rooms. It keeps the data of each room in a Durable Object, in the EU jurisdiction when the region is "eu". */
const app = createApp(serviceFor, {
  live: (env) => {
    const rooms = (env as LiveEnv).SYNC_ROOM;
    if (!rooms) throw new Error("bind a Durable Object namespace as SYNC_ROOM");
    return createDurableObjectRealtime(rooms, env.AGENTIC_DOCS_REGION === "eu" ? "eu" : undefined);
  },
});

export default { fetch: (request: Request, env: LiveEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
