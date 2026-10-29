import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { Button, Checkbox, Dialog, DialogClose, Input } from "agentic-design/react";

/** The sources the engine renders: web addresses, and small embedded pictures. */
const SOURCE = /^(https?:\/\/\S+|data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+)$/i;

/** The most characters in an embedded image. It goes into the document and to every peer, and the whole document has a 1 MB limit. */
const MAX_SOURCE = 256_000;

/**
 * Insert an image, or change the one that is selected. Every image has alt text (WCAG 1.1.1): a description, or the
 * decorative choice, which writes an empty alt so a screen reader skips the image.
 */
export function ImageDialog({ editor, open, onOpenChange }: { editor: Editor | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [src, setSrc] = useState("");
  const [alt, setAlt] = useState("");
  const [decorative, setDecorative] = useState(false);
  const [opened, setOpened] = useState("");
  const [error, setError] = useState<{ src?: string; alt?: string }>({});
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

  function apply() {
    if (!editor) return;
    const address = src.trim();
    const text = alt.trim();
    // An image the engine took from Markdown can have a source this dialog would not accept. Its alt text can still change.
    const problem = { src: (editing && address === opened) || (SOURCE.test(address) && address.length <= MAX_SOURCE) ? undefined : "Use a web address that starts with https:// or http://, or an embedded PNG, JPEG, GIF, or WebP image under 256 KB.", alt: decorative || text ? undefined : "Describe the image, or mark it as decorative." };
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
      <form className="adoc form" onSubmit={(e) => (e.preventDefault(), apply())}>
        <Input label="Image address" value={src} onChange={(e) => setSrc(e.target.value)} error={error.src} placeholder="https://" hint="A page can block web images. An embedded image always shows." autoComplete="off" />
        <Input label="Alt text" value={decorative ? "" : alt} onChange={(e) => setAlt(e.target.value)} error={error.alt} disabled={decorative} autoComplete="off" />
        <Checkbox label="Decorative image, with no description" checked={decorative} onChange={(e) => (setDecorative(e.target.checked), setError((now) => ({ ...now, alt: undefined })))} />
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
          <Button type="submit">{editing ? "Apply" : "Insert"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
