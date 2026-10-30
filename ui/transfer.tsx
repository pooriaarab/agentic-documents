// Markdown in and out of the editor. The conversion is the one the server uses (src/markdown.ts), so a download
// matches what `doc_read` returns, and an import accepts what `doc_new` accepts.
import type { Editor } from "@tiptap/core";
import { Button, Dialog, DialogClose, Input } from "agentic-design/react";
import { useEffect, useState, type FormEvent } from "react";
import { prosemirrorJSONToYDoc } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { MAX_LIVE_BYTES } from "../src/limits.js";
import { blocksToMarkdown, markdownToBlocks, type PmNode } from "../src/markdown.js";
import { allowedSource } from "./image.js";

/**
 * The largest Markdown file an import reads. An import is one Yjs update, and a room closes a message over 1 MiB and
 * a document over MAX_LIVE_BYTES cannot be saved, so this stays well under both.
 */
const MAX_MARKDOWN_BYTES = 512 * 1024;

/** The text of the editor as Markdown. */
export const editorMarkdown = (editor: Editor): string => blocksToMarkdown((editor.getJSON().content ?? []) as PmNode[]);

/** The blocks without an image that a paste would not keep either: see `allowedSource`. */
const keepImages = (nodes: PmNode[]): PmNode[] =>
  nodes.flatMap((node) => (node.type === "image" && !allowedSource(String(node.attrs?.src ?? "")) ? [] : [node.content ? { ...node, content: keepImages(node.content) } : node]));

/**
 * Replace the text of the editor with Markdown. An image is dropped when the editor would not keep it from a paste. It
 * throws an error with a message when the Markdown has a part the
 * document cannot keep, or when the document would pass the room limit.
 */
export function setEditorMarkdown(editor: Editor, markdown: string): void {
  const content = keepImages(markdownToBlocks(markdown));
  const doc = { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
  // Many small blocks make a Yjs document much larger than its Markdown, so measure the document itself. It must stay
  // under the room limit, with room to spare for what is deleted and for later typing.
  const size = Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(editor.schema, doc, "default")).byteLength;
  if (size > MAX_LIVE_BYTES * 0.9) throw new Error(`As a document it is about ${Math.ceil(size / 1024)} KB, more than the ${Math.floor((MAX_LIVE_BYTES * 0.9) / 1024)} KB a live room keeps.`);
  editor.chain().focus().setContent(doc.content).run();
}

/** Save the text as a `.md` file. */
export function downloadMarkdown(editor: Editor, title: string): void {
  const url = URL.createObjectURL(new Blob([editorMarkdown(editor)], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "document"}.md`;
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
