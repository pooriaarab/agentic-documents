import { useEffect, useState, type FormEvent } from "react";
import { Button, Dialog, DialogClose, Input, PresenceChip, type PresenceEntry, type DialogProps } from "agentic-design/react";
import { describe, isMachine, useSession } from "./api.js";

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
  useEffect(() => {
    if (open) setTitle("");
  }, [open]);
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="New document" submit="Create" onDone={() => onOpenChange?.(false)}
      action={async () => {
        const id = idFor(title);
        await api.create({ id });
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

/** Who made changes here, and a link. Roles and invites need the sharing API, which this server does not have yet. */
export function ShareDocument({ id, open, onOpenChange }: Shared & { id: string }) {
  const { api } = useSession();
  const [people, setPeople] = useState<PresenceEntry[]>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    api.room(id).then(({ contributors }) => setPeople(contributors.map((c) => ({ id: `${c.kind}:${c.name}`, name: c.name, kind: isMachine(c.kind) ? "agent" : "person" }))), () => setPeople([]));
  }, [open, api, id]);
  const link = `${location.origin}/#/d/${encodeURIComponent(id)}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Share document" description="Anyone with an access token for this server can open this link.">
      <div className="form">
        <Input label="Link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
        <div className="form-actions">
          <Button type="button" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true), () => setCopied(false))}>Copy link</Button>
          <span role="status">{copied ? "Link copied." : ""}</span>
        </div>
        <h3 className="section-title">Who has changed this document</h3>
        {people === undefined ? <p role="status">Loading…</p> : people.length === 0 ? <p>Nobody has edited it in a live room yet.</p> : <ul className="people">{people.map((p) => <li key={p.id}><PresenceChip entry={p} /></li>)}</ul>}
        <p className="muted">Roles, invites, and expiring links are not available yet.</p>
      </div>
    </Dialog>
  );
}
