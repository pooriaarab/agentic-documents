// Markdown in and out of the editor. The conversion is the one the server uses (src/markdown.ts), so a download
// matches what `doc_read` returns, and an import accepts what `doc_new` accepts.
import type { Editor } from "@tiptap/core";
import { Button, Dialog, DialogClose, Input } from "agentic-design/react";
import { useEffect, useState, type FormEvent } from "react";
import { blocksToMarkdown, markdownToBlocks, type PmNode } from "../src/markdown.js";
import { allowedSource } from "./image.js";

/** The largest Markdown file an import reads. */
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/** The text of the editor as Markdown. */
export const editorMarkdown = (editor: Editor): string => blocksToMarkdown((editor.getJSON().content ?? []) as PmNode[]);

/** The blocks without an image that a paste would not keep either: see `allowedSource`. */
const keepImages = (nodes: PmNode[], remote: boolean): PmNode[] =>
  nodes.flatMap((node) => (node.type === "image" && !allowedSource(String(node.attrs?.src ?? ""), remote) ? [] : [node.content ? { ...node, content: keepImages(node.content, remote) } : node]));

/**
 * Replace the text of the editor with Markdown. An image is dropped when the editor would not keep it from a paste:
 * with `remote`, an `https://` address is kept. It throws an error with a message when the Markdown has a part the
 * document cannot keep.
 */
export function setEditorMarkdown(editor: Editor, markdown: string, remote = true): void {
  const content = keepImages(markdownToBlocks(markdown), remote);
  editor.chain().focus().setContent(content.length ? content : [{ type: "paragraph" }]).run();
}

/** Save the text as a `.md` file. */
export function downloadMarkdown(editor: Editor, title: string): void {
  const url = URL.createObjectURL(new Blob([editorMarkdown(editor)], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim() || "document"}.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a Markdown file and put it in place of the text, for everyone in the room. */
export function ImportDialog({ editor, open, onOpenChange, remote }: { editor: Editor | undefined; open: boolean; onOpenChange: (open: boolean) => void; remote: boolean }) {
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
    if (file.size > MAX_MARKDOWN_BYTES) return setError("Use a file of 2 MB or less.");
    let markdown: string;
    try {
      markdown = await file.text();
    } catch {
      return setError("The file could not be read. Choose it again.");
    }
    try {
      setEditorMarkdown(editor, markdown, remote);
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
