import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState } from "agentic-design/react";
import { describe, useSession } from "./api.js";
import { useEditorSession } from "./embed.js";
import { PageHeading } from "./focus.js";
import { DeleteDocument, RenameDocument, ShareDocument } from "./dialogs.js";
import { Boundary, Surface } from "./editor.js";

/** The live room of a document on this Worker. */
function roomOf(id: string, token: string, baseUrl: string) {
  const url = new URL(`/api/v1/docs/${encodeURIComponent(id)}/ws`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { url: url.toString(), token };
}

export function EditorView({ id, go }: { id: string; go: (hash: string) => void }) {
  const { api, token, me, baseUrl } = useSession();
  const [title, setTitle] = useState<{ id: string; title: string } | { id: string; error: unknown }>();
  const [dialog, setDialog] = useState<"rename" | "delete" | "share">();
  const [attempt, setAttempt] = useState(0);
  const room = useMemo(() => roomOf(id, token, baseUrl), [id, token, baseUrl]);
  // A save on leave never makes a document, so after a delete it fails with NO_DOCUMENT and the document stays deleted.
  const load = useEditorSession(api, id, me.name, me.role === "editor", room, attempt);

  const readTitle = () => api.list().then((docs) => setTitle({ id, title: docs.find((d) => d.id === id)?.title ?? id }), (error: unknown) => setTitle({ id, error }));
  useEffect(() => void readTitle(), [api, id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = load.state === "error" ? load.error : title && "error" in title ? title.error : undefined;
  if (failed !== undefined) {
    return (
      <div role="alert" className="notice">
        <EmptyState title="Could not open this document" description={describe(failed)} action={<><Button onClick={() => setAttempt(attempt + 1)}>Try again</Button> <Button variant="secondary" onClick={() => go("#/")}>Back to documents</Button></>} />
      </div>
    );
  }
  if (load.state !== "ready" || !title || title.id !== id || !("title" in title)) return <p role="status" className="muted">Opening document…</p>;
  return (
    <>
      <div className="page-head">
        <PageHeading>{title.title}</PageHeading>
        <div className="page-actions">
          {me.role === "editor" && <Button variant="secondary" onClick={() => setDialog("rename")}>Rename</Button>}
          <Button onClick={() => setDialog("share")}>Share</Button>
          {me.role === "editor" && <Button variant="danger" onClick={() => setDialog("delete")}>Delete</Button>}
        </div>
      </div>
      <Boundary><Surface live={load.live} editable={me.role === "editor"} principal={me} /></Boundary>
      <RenameDocument id={id} current={title.title} open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(undefined)} onDone={() => void readTitle()} />
      <DeleteDocument id={id} name={title.title} open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(undefined)} onDone={() => go("#/")} />
      <ShareDocument id={id} open={dialog === "share"} onOpenChange={(o) => !o && setDialog(undefined)} />
    </>
  );
}
