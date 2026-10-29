import { useEffect, useRef, useState, type FormEvent } from "react";
import { DocsApiError } from "../src/client.js";
import { Button, Dialog, DialogClose, Input, type DialogProps } from "agentic-design/react";
import { describe, useSession } from "./api.js";

type Shared = Pick<DialogProps, "open" | "onOpenChange" | "trigger">;

/** A form in a dialog: it shows the error from the server and stays open on failure. */
function FormDialog({ title, description, submit, danger, action, children, onDone, ...dialog }: Shared & { title: string; description?: string; submit: string; danger?: boolean; action: () => Promise<void>; children?: React.ReactNode; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (dialog.open) setError(undefined);
  }, [dialog.open]);
  async function run(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onDone();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog {...dialog} title={title} description={description}>
      <form onSubmit={run} className="form">
        {children}
        {error && <p role="alert" className="form-error">{error}</p>}
        <div className="form-actions">
          <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
          <Button type="submit" variant={danger ? "danger" : "primary"} loading={busy}>{submit}</Button>
        </div>
      </form>
    </Dialog>
  );
}

const idFor = (title: string) => `${title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "doc"}-${crypto.randomUUID().slice(0, 6)}`;

export function NewDocument({ open, onOpenChange, onCreated }: Shared & { onCreated: (id: string) => void }) {
  const { api } = useSession();
  const [title, setTitle] = useState("");
  const made = useRef<string | undefined>(undefined); // a retry after a failed rename reuses the document that was made
  useEffect(() => {
    if (open) (setTitle(""), (made.current = undefined));
  }, [open]);
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="New document" submit="Create" onDone={() => onOpenChange?.(false)}
      action={async () => {
        const retry = made.current !== undefined;
        const id = (made.current ??= idFor(title));
        await api.create({ id }).catch((e: unknown) => {
          if (retry && e instanceof DocsApiError && e.code === "DOCUMENT_EXISTS") return; // the first try made it
          made.current = undefined; // a failed create makes nothing, so the next try picks a new id
          return Promise.reject(e);
        });
        if (title.trim()) await api.rename(id, { title });
        onCreated(id);
      }}>
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoComplete="off" hint="You can change it later." />
    </FormDialog>
  );
}

export function RenameDocument({ id, current, open, onOpenChange, onDone }: Shared & { id: string; current: string; onDone: () => void }) {
  const { api } = useSession();
  const [title, setTitle] = useState(current);
  useEffect(() => {
    if (open) setTitle(current);
  }, [open, current]);
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Rename document" submit="Rename" onDone={() => (onOpenChange?.(false), onDone())} action={() => api.rename(id, { title }).then(() => undefined)}>
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoComplete="off" />
    </FormDialog>
  );
}

export function DeleteDocument({ id, name, open, onOpenChange, onDone }: Shared & { id: string; name: string; onDone: () => void }) {
  const { api } = useSession();
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} danger title="Delete document" description={`Delete "${name}" for everyone? This cannot be undone.`} submit="Delete" onDone={() => (onOpenChange?.(false), onDone())} action={() => api.remove(id).then(() => undefined)} />
  );
}

export { ShareDocument } from "./share.js";
