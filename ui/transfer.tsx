// Markdown in and out of the editor. The conversion is the one the server uses (src/markdown.ts), so a download
// matches what `doc_read` returns, and an import accepts what `doc_new` accepts.
import type { Editor } from "@tiptap/core";
import { Button, Dialog, DialogClose, Input } from "agentic-design/react";
import { useEffect, useState, type FormEvent } from "react";
import { prosemirrorJSONToYXmlFragment, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { blocksToMarkdown, markdownToBlocks, type PmNode } from "../src/markdown.js";
import { allowedSource, DOCUMENT_LIMIT } from "./image.js";

/**
 * The largest Markdown file an import reads. An import is one Yjs update, and a room closes a message over 1 MiB and
 * a document over the room limit cannot be saved, so this stays well under both.
 */
const MAX_MARKDOWN_BYTES = 512 * 1024;

/** The text of the editor as Markdown. */
export const editorMarkdown = (editor: Editor): string => blocksToMarkdown((editor.getJSON().content ?? []) as PmNode[]);

/** The blocks without an image that a paste would not keep either: see `allowedSource`. */
const keepImages = (nodes: PmNode[]): PmNode[] =>
  nodes.flatMap((node) => (node.type === "image" && !allowedSource(String(node.attrs?.src ?? "")) ? [] : [node.content ? { ...node, content: keepImages(node.content) } : node]));

/**
 * Replace the text of the editor with Markdown. An image is dropped when the editor would not keep it from a paste. It
 * throws an error when the Markdown has a part the document cannot keep, when the old and new text together
 * pass the room limit, or when the editor is read only.
 */
export function setEditorMarkdown(editor: Editor, markdown: string): void {
  // A read-only editor never saves, so text put in it would only differ from the room.
  if (!editor.isEditable) throw new TypeError("the editor is read only, so its text cannot be replaced");
  const content = keepImages(markdownToBlocks(markdown));
  const doc = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
  const room = ySyncPluginKey.getState(editor.state) as { doc?: Y.Doc } | undefined;
  if (!room?.doc) throw new TypeError("The editor has no sync document, so its text cannot be replaced.");
  const current = Y.encodeStateAsUpdate(room.doc);
  // Keep deleted content as undo does. Reuse the live client id and clock, since new items can cost more than
  // the same content built as a fresh document. Deleting all content gives a conservative replacement budget.
  const scratch = new Y.Doc({ gc: false });
  let size: number;
  try {
    Y.applyUpdate(scratch, current);
    scratch.clientID = room.doc.clientID;
    const fragment = scratch.getXmlFragment("default");
    fragment.delete(0, fragment.length);
    prosemirrorJSONToYXmlFragment(editor.schema, doc, fragment);
    size = Y.encodeStateAsUpdate(scratch).byteLength;
  } finally {
    scratch.destroy();
  }
  if (size + 1024 > DOCUMENT_LIMIT) throw new Error(`The import would use about ${Math.ceil(size / 1024)} KB, including the ${Math.ceil(current.byteLength / 1024)} KB this document has now. That is more than the ${Math.floor(DOCUMENT_LIMIT / 1024)} KB a live room keeps.`);
  editor.chain().focus().setContent(doc.content).run();
}

/** Save the text as a `.md` file. */
export function downloadMarkdown(editor: Editor, title: string): void {
  const url = URL.createObjectURL(new Blob([editorMarkdown(editor)], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  // Characters a file name cannot hold become spaces. A trailing dot and the names Windows reserves get a prefix or go.
  const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim() || "document";
  link.download = `${/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) ? `document ${name}` : name}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a Markdown file and put it in place of the text, for everyone in the room. */
export function ImportDialog({ editor, open, onOpenChange }: { editor: Editor | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [file, setFile] = useState<File>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) (setFile(undefined), setError(undefined));
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    if (!editor.isEditable) return setError("This document is read only now, so the file cannot replace its text.");
    if (!file) return setError("Choose a Markdown file.");
    if (file.size > MAX_MARKDOWN_BYTES) return setError("Use a file of 512 KB or less.");
    let markdown: string;
    try {
      markdown = await file.text();
    } catch {
      return setError("The file could not be read. Choose it again.");
    }
    try {
      setEditorMarkdown(editor, markdown);
    } catch (e) {
      return setError(`This file cannot be imported. ${e instanceof Error ? e.message : ""}`.trim());
    }
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Import Markdown" description="The file replaces all the text of this document, for everyone who has it open. Undo takes it back.">
      <form className="agd-form" onSubmit={(e) => void submit(e)}>
        <Input label="Markdown file" type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={(e) => setFile(e.target.files?.[0])} />
        {error && <p role="alert" className="agd-form-error">{error}</p>}
        <div className="agd-form-actions">
          <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
          <Button type="submit" variant="danger">Replace the text</Button>
        </div>
      </form>
    </Dialog>
  );
}
