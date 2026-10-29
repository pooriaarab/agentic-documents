// A host app that keeps the document in its own Yjs room, and gives that document to `agentic-documents/ui` as `host`.
import { SyncClient, type Status } from "agentic-realtime/client";
import { createClient } from "agentic-documents/client";
import { mountEditor } from "agentic-documents/ui";
import * as Y from "yjs";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? "";
const id = params.get("id") ?? "";
const principal = { kind: params.get("kind") as "human", name: params.get("name") ?? "", role: (params.get("role") ?? "editor") as "editor" };

const base64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// The host's own socket. The room reads the token from a subprotocol.
class HostSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, ["agentic-docs", `agentic-docs.bearer.${base64url(token)}`]);
  }
}

const url = new URL(`/api/v1/docs/${encodeURIComponent(id)}/ws`, location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const doc = new Y.Doc();
// The host's own copy. Here it comes from the stored document. An app may keep it anywhere.
Y.applyUpdate(doc, await createClient({ baseUrl: location.origin, token }).state(id));
let status: Status = "connecting";
const listeners = new Set<(status: Status) => void>();
const sync = SyncClient.open({ url: url.toString(), WebSocket: HostSocket as never, doc, presence: { name: principal.name }, reconnect: {},
  onStatus: (next) => {
    status = next;
    for (const listener of listeners) listener(next);
  },
});
await sync.whenSynced();
let editors = 0;
const editor = mountEditor(document.getElementById("editor")!, {
  id,
  principal,
  host: { doc, presence: sync, status: () => status, onStatus: (listener) => (listeners.add(listener), () => void listeners.delete(listener)) },
  onEditor: (made) => void (made && editors++),
});
Object.assign(window, {
  unmountEditor: () => editor.unmount(),
  // The host still holds the document and the room after the editor goes.
  hostText: () => doc.getXmlFragment("default").toDOM().textContent,
  hostStatus: () => status,
  editorsSeen: () => editors,
});
