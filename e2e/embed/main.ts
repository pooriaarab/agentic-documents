// A host app for the tests. It uses the package exports as a host would: `agentic-documents/ui` and `/client`.
import { createClient } from "agentic-documents/client";
import { Extension, Mark, type Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { mountEditor, setEditorMarkdown, type BubbleAction, type SlashItem } from "agentic-documents/ui";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? "";
const id = params.get("id") ?? "";
const client = createClient({ baseUrl: location.origin, token });
const me = await client.me();
const url = new URL(`/api/v1/docs/${encodeURIComponent(id)}/ws`, location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
// With `extras`, the host adds a slash item, a bubble tool, and a keyboard shortcut, as an app with comments or an
// assistant would. With `badext`, it adds a mark and a paragraph attribute, which the editor refuses.
const seen: { comment?: string; shortcut?: boolean } = {};
const slashItems: SlashItem[] = [{ title: "Signature", description: "Sign the text", run: (e) => e.chain().focus().insertContent("Signed, the host").run() }];
const bubbleActions: BubbleAction[] = [{ label: "Comment", icon: "C", run: (e) => void (seen.comment = e.state.doc.textBetween(e.state.selection.from, e.state.selection.to)) }];
const extensions = [
  Extension.create({ name: "hostKeys", addKeyboardShortcuts: () => ({ "Mod-Shift-y": () => ((seen.shortcut = true), true) }) }),
  ...(params.has("badext")
    ? [
        Mark.create({ name: "hostHighlight", parseHTML: () => [{ tag: "mark" }], renderHTML: () => ["mark", 0] }),
        Extension.create({ name: "hostTone", addGlobalAttributes: () => [{ types: ["paragraph"], attributes: { tone: { default: null } } }] }),
        // The same name as the built-in image, with the same attributes, but a block: what it can hold changes.
        Image.extend({ inline: false, group: "block" }),
      ]
    : []),
];
let current: Editor | null = null;
const editor = mountEditor(document.getElementById("editor")!, {
  id,
  client,
  principal: me,
  room: params.has("noroom") ? undefined : { url: url.toString(), token },
  ...(params.has("extras") ? { slashItems, bubbleActions, extensions } : {}),
  onEditor: (e) => void (current = e),
});
const tryImport = () => {
  try {
    setEditorMarkdown(current!, "# Replaced");
    return "ok";
  } catch (e) {
    return e instanceof Error ? e.message : "error";
  }
};
Object.assign(window, { seen, tryImport });
Object.assign(window, { unmountEditor: () => editor.unmount() });
