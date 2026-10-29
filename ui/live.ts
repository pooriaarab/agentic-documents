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

/** The calls the editor makes. A `DocsClient` from `agentic-documents/client` has them. */
export type EditorClient = Pick<DocsClient, "state" | "checkpoint">;

/** A live room of agentic-realtime for one document. */
export interface EditorRoom {
  /** The WebSocket address of the room, such as `wss://docs.example.com/api/v1/docs/plan/ws`. */
  url: string;
  /** A bearer token for the room. In a browser it goes in a WebSocket subprotocol. */
  token?: string;
  /** Your own WebSocket class, for a room that takes its token another way. */
  WebSocket?: new (url: string, options?: { headers?: Record<string, string> }) => WebSocket;
}

export interface LiveSession {
  /** The room, or undefined when the document is open without one. */
  sync?: SyncClient;
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

/**
 * Open one document. It starts from the stored document and fails with NO_DOCUMENT when there is none. With a room, edits
 * go to the room as they happen. Without one, only `save` sends them.
 */
export async function openSession(client: EditorClient, id: string, name: string, room?: EditorRoom): Promise<LiveSession> {
  let status: Status = room ? "connecting" : "connected";
  const listeners = new Set<(status: Status) => void>();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await client.state(id));
  const sync = room
    ? await SyncClient.connect({ url: room.url, headers: room.token ? { authorization: `Bearer ${room.token}` } : undefined, WebSocket: room.WebSocket ?? TokenSocket, doc, presence: { name }, reconnect: {},
        onStatus: (next) => {
          status = next;
          for (const listener of listeners) listener(next);
        },
      })
    : undefined;
  // Open the editor once the room has sent what it holds, so its first update does not land under the first keystroke.
  await sync?.whenSynced().catch(() => undefined);
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
      await sync?.flush();
      await client.checkpoint(id, Y.encodeStateAsUpdate(doc), { create: false });
      saved = mark;
    },
    close: async () => await sync?.disconnect(),
  };
  return session;
}
