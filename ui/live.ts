import { SyncClient, type Status } from "agentic-realtime/client";
import * as Y from "yjs";
import type { DocsClient } from "../src/client.js";

const base64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A browser WebSocket cannot send an Authorization header. The Worker reads the token from a subprotocol instead. */
class TokenSocket extends WebSocket {
  constructor(url: string | URL, options?: { headers?: Record<string, string> }) {
    const token = /^Bearer (.+)$/.exec(options?.headers?.authorization ?? "")?.[1];
    super(url, token ? ["agentic-docs", `agentic-docs.bearer.${base64url(token)}`] : undefined);
  }
}

export interface LiveSession {
  sync: SyncClient;
  doc: Y.Doc;
  /** The socket state now, and a way to hear when it changes. */
  status: () => Status;
  onStatus: (listener: (status: Status) => void) => () => void;
  /** True when this tab changed the text since the last save that worked. */
  readonly dirty: boolean;
  /** Call it when this tab changes the text. */
  touch(): void;
  /** Merge the room into the stored document. It never makes a document: a removed one fails with NO_DOCUMENT. */
  save(): Promise<void>;
  close(): Promise<void>;
}

/** Open one document in its live room. It starts from the stored document and fails with NO_DOCUMENT when there is none. */
export async function openSession(api: DocsClient, token: string, id: string, name: string): Promise<LiveSession> {
  let status: Status = "connecting";
  const listeners = new Set<(status: Status) => void>();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await api.state(id));
  const url = new URL(`/api/v1/docs/${encodeURIComponent(id)}/ws`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const sync = await SyncClient.connect({ url: url.toString(), headers: { authorization: `Bearer ${token}` }, WebSocket: TokenSocket, doc, presence: { name }, reconnect: {},
    onStatus: (next) => {
      status = next;
      for (const listener of listeners) listener(next);
    },
  });
  // Open the editor once the room has sent what it holds, so its first update does not land under the first keystroke.
  await sync.whenSynced().catch(() => undefined);
  let changes = 0;
  let saved = 0;
  const session: LiveSession = {
    sync,
    doc,
    status: () => status,
    onStatus: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    get dirty() {
      return changes !== saved;
    },
    touch: () => void changes++,
    async save() {
      const mark = changes; // a change made while the save runs stays dirty
      await sync.flush();
      await api.checkpoint(id, Y.encodeStateAsUpdate(doc), { create: false });
      saved = mark;
    },
    close: () => sync.disconnect(),
  };
  return session;
}
