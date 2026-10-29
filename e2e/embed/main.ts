// A host app for the tests. It uses the package exports as a host would: `agentic-documents/ui` and `/client`.
import { createClient } from "agentic-documents/client";
import { Extension } from "@tiptap/core";
import { mountEditor, type BubbleAction, type SlashItem } from "agentic-documents/ui";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? "";
const id = params.get("id") ?? "";
const client = createClient({ baseUrl: location.origin, token });
const me = await client.me();
const url = new URL(`/api/v1/docs/${encodeURIComponent(id)}/ws`, location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
// With `extras`, the host adds a slash item, a bubble tool that a viewer gets too, and a keyboard shortcut, as an app
// with comments or an assistant would.
const seen: { comment?: string; shortcut?: boolean } = {};
const slashItems: SlashItem[] = [{ title: "Signature", description: "Sign the text", run: (e) => e.chain().focus().insertContent("Signed, the host").run() }];
const bubbleActions: BubbleAction[] = [{ label: "Comment", icon: "C", readOnly: true, run: (e) => void (seen.comment = e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)) }];
const extensions = [Extension.create({ name: "hostKeys", addKeyboardShortcuts: () => ({ "Mod-Shift-y": () => ((seen.shortcut = true), true) }) })];
const editor = mountEditor(document.getElementById("editor")!, {
  id,
  client,
  principal: me,
  room: params.has("noroom") ? undefined : { url: url.toString(), token },
  ...(params.has("extras") ? { slashItems, bubbleActions, extensions } : {}),
});
Object.assign(window, { seen });
Object.assign(window, { unmountEditor: () => editor.unmount() });
