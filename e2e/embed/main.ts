// A host app for the tests. It uses the package exports as a host would: `agentic-documents/ui` and `/client`.
import { createClient } from "agentic-documents/client";
import { mountEditor } from "agentic-documents/ui";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? "";
const id = params.get("id") ?? "";
const client = createClient({ baseUrl: location.origin, token });
const me = await client.me();
const url = new URL(`/api/v1/docs/${encodeURIComponent(id)}/ws`, location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const editor = mountEditor(document.getElementById("editor")!, { id, client, principal: me, room: params.has("solo") ? undefined : { url: url.toString(), token } });
Object.assign(window, { unmountEditor: () => editor.unmount() });
