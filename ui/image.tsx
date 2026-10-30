import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import * as Y from "yjs";
import { Button, Checkbox, Dialog, DialogClose, Input } from "agentic-design/react";

/** The sources the engine renders: web addresses, and small embedded pictures. */
const SOURCE = /^(https?:\/\/\S+|data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+)$/i;

/** The whole document has a 1 MB limit, and an embedded image counts against it. This keeps one image small, and room is checked too. */
const MAX_SOURCE = 256_000;
const DOCUMENT_LIMIT = 900_000;
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** A source the editor keeps from pasted HTML: the same rule as the dialog, so a copy and paste inside the text keeps it. */
export const allowedSource = (src: string): boolean => SOURCE.test(src) && src.length <= MAX_SOURCE;

/** The image of the editor: inline, as the engine schema has it. Pasted HTML keeps an image only when its source is allowed. */
export const DocImage = Image.extend({
  parseHTML: () => [{ tag: "img[src]", getAttrs: (el: HTMLElement) => (allowedSource(el.getAttribute("src") ?? "") ? null : false) }],
}).configure({ inline: true });

const read = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
    reader.readAsDataURL(file);
  });

/**
 * Insert an image, or change the one that is selected. Every image has alt text (WCAG 1.1.1): a description, or the
 * decorative choice, which writes an empty alt so a screen reader skips the image.
 */
export function ImageDialog({ editor, doc, open, onOpenChange }: { editor: Editor | undefined; doc: Y.Doc; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [src, setSrc] = useState("");
  const [alt, setAlt] = useState("");
  const [decorative, setDecorative] = useState(false);
  const [opened, setOpened] = useState("");
  const [error, setError] = useState<{ src?: string; alt?: string }>({});
  const [file, setFile] = useState<File>();
  const picker = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);
  const editing = open && editor?.isActive("image") === true;

  useEffect(() => {
    if (!open) return;
    // getAttributes reads any image in the selected range, so only a selected image fills the fields.
    const now = editor?.isActive("image") ? editor.getAttributes("image") : {};
    setSrc(typeof now.src === "string" ? now.src : "");
    setOpened(typeof now.src === "string" ? now.src : "");
    // An empty alt can mean decorative, or that nobody wrote a description. The person chooses, so Decorative starts off.
    setAlt(typeof now.alt === "string" ? now.alt : "");
    setDecorative(false);
    setError({});
    setFile(undefined);
  }, [open, editor]);

  // The dialog gives focus back to the toolbar button when it closes. After Apply, writing goes on in the text.
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    let tries = 0;
    const timer = setInterval(() => {
      if (editor?.isFocused || ++tries > 10) return clearInterval(timer);
      editor?.view.focus();
    }, 40);
    return () => clearInterval(timer);
  }, [open, editor]);

  async function apply() {
    if (!editor) return;
    let address = src.trim();
    // A chosen file is read into an embedded image, which then passes the same checks as a typed one.
    if (file) {
      if (!TYPES.includes(file.type)) return setError({ src: "Use a PNG, JPEG, GIF, or WebP image file." });
      try {
        address = await read(file);
      } catch {
        return setError({ src: "The file could not be read. Try another file." });
      }
    }
    const text = alt.trim();
    // An image the engine took from Markdown can have a source this dialog would not accept. Its alt text can still change.
    const problem: { src?: string; alt?: string } = { src: (editing && address === opened) || (SOURCE.test(address) && address.length <= MAX_SOURCE) ? undefined : "Use a web address that starts with https:// or http://, or an embedded PNG, JPEG, GIF, or WebP image of up to about 180 KB.", alt: decorative || text ? undefined : "Describe the image, or mark it as decorative." };
    if (!problem.src && address !== opened && address.length > 1000 && Y.encodeStateAsUpdate(doc).length + address.length > DOCUMENT_LIMIT) problem.src = "The document has no room for this image. Use a smaller image or a web address.";
    if (problem.src || problem.alt) return setError(problem);
    const attrs = { src: address, alt: decorative ? "" : text };
    if (editor.isActive("image")) editor.chain().focus().updateAttributes("image", attrs).run();
    else editor.chain().focus().insertContentAt(editor.state.selection.to, { type: "image", attrs }).run(); // after the selection, so no text is replaced
    // Put the caret after the image. A selected image is replaced by the next key.
    editor.chain().setTextSelection(editor.state.selection.to).run();
    refocus.current = true;
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={editing ? "Image" : "Insert image"} description="Alt text tells people who cannot see the image what it shows.">
      <form className="agd-form" onSubmit={(e) => (e.preventDefault(), void apply())}>
        <Input label="Image address" value={src} onChange={(e) => setSrc(e.target.value)} error={error.src} placeholder="https://" hint="A page can block web images. An embedded image always shows." autoComplete="off" disabled={file !== undefined} />
        <Input ref={picker} label="Or image file" type="file" accept={TYPES.join(",")} hint="A PNG, JPEG, GIF, or WebP file of up to about 180 KB, stored in the document." onChange={(e) => (setFile(e.target.files?.[0]), setError((now) => ({ ...now, src: undefined })))} />
        {file && <div><Button type="button" variant="secondary" size="sm" onClick={() => (setFile(undefined), picker.current && (picker.current.value = ""))}>Remove file</Button></div>}
        <Input label="Alt text" value={decorative ? "" : alt} onChange={(e) => setAlt(e.target.value)} error={error.alt} disabled={decorative} autoComplete="off" />
        <Checkbox label="Decorative image, with no description" checked={decorative} onChange={(e) => (setDecorative(e.target.checked), setError((now) => ({ ...now, alt: undefined })))} />
        <div className="agd-form-actions">
          <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
          <Button type="submit">{editing ? "Apply" : "Insert"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
