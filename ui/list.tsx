import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, FileList, FileRow, IconButton, Menu, MoreIcon, PlusIcon } from "agentic-design/react";
import type { DocSummary } from "../src/client.js";
import { describe, isMachine, useSession } from "./api.js";
import { PageHeading } from "./focus.js";
import { DeleteDocument, NewDocument, RenameDocument } from "./dialogs.js";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; docs: DocSummary[] };

export function DocumentList({ go }: { go: (hash: string) => void }) {
  const { api, me } = useSession();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<DocSummary>();
  const [deleting, setDeleting] = useState<DocSummary>();
  const canWrite = me.role === "editor";

  const refresh = useCallback(() => {
    setLoad({ state: "loading" });
    api.list().then(
      (docs) => setLoad({ state: "ready", docs: docs.sort((a, b) => b.updatedAt - a.updatedAt) }),
      (e: unknown) => setLoad({ state: "error", message: describe(e) }),
    );
  }, [api]);
  useEffect(refresh, [refresh]);

  const newButton = canWrite ? <Button onClick={() => setCreating(true)}><PlusIcon aria-hidden /> New document</Button> : undefined;
  return (
    <>
      <div className="page-head">
        <PageHeading>Documents</PageHeading>
        {load.state === "ready" && load.docs.length > 0 && newButton}
      </div>
      {load.state === "loading" && <p role="status" className="muted">Loading documents…</p>}
      {load.state === "error" && (
        <div role="alert" className="notice">
          <EmptyState title="Could not load documents" description={load.message} action={<Button onClick={refresh}>Try again</Button>} />
        </div>
      )}
      {load.state === "ready" && load.docs.length === 0 && (
        <EmptyState title="No documents yet" description={canWrite ? "Make one to start writing, with people and agents." : "Nothing has been shared with this token."} action={newButton} />
      )}
      {load.state === "ready" && load.docs.length > 0 && (
        <FileList label="Documents">
          {load.docs.map((doc) => (
            <FileRow
              key={doc.id}
              name={doc.title}
              href={`#/d/${encodeURIComponent(doc.id)}`}
              modified={new Date(doc.updatedAt)}
              editedBy={{ id: `${doc.updatedBy.kind}:${doc.updatedBy.name}`, name: doc.updatedBy.name, kind: isMachine(doc.updatedBy.kind) ? "agent" : "person" }}
              actions={
                canWrite && (
                  <Menu
                    align="end"
                    trigger={<IconButton label={`Actions for ${doc.title}`} icon={<MoreIcon aria-hidden />} variant="ghost" />}
                    items={[{ label: "Rename", onSelect: () => setRenaming(doc) }, "separator", { label: "Delete", danger: true, onSelect: () => setDeleting(doc) }]}
                  />
                )
              }
            />
          ))}
        </FileList>
      )}
      <NewDocument open={creating} onOpenChange={setCreating} onCreated={(id) => go(`#/d/${encodeURIComponent(id)}`)} />
      <RenameDocument id={renaming?.id ?? ""} current={renaming?.title ?? ""} open={renaming !== undefined} onOpenChange={(open) => !open && setRenaming(undefined)} onDone={refresh} />
      <DeleteDocument id={deleting?.id ?? ""} name={deleting?.title ?? ""} open={deleting !== undefined} onOpenChange={(open) => !open && setDeleting(undefined)} onDone={refresh} />
    </>
  );
}
