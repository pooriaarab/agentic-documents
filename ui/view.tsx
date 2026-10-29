import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, IconButton, Menu, MoreIcon, useTheme, type MenuItem, type ThemePreference } from "agentic-design/react";
import { describe, useSession } from "./api.js";
import { useEditorSession } from "./embed.js";
import { PageHeading } from "./focus.js";
import { DeleteDocument, RenameDocument, ShareDocument } from "./dialogs.js";
import { Boundary, Surface } from "./editor.js";
import { icons } from "./icons.js";
import { downloadMarkdown, ImportDialog } from "./transfer.js";
import type { Editor } from "@tiptap/core";

/** The live room of a document on this Worker. */
export function roomOf(id: string, token: string, baseUrl: string) {
  // Keep any path in `baseUrl`, as the client does.
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/api/v1/docs/${encodeURIComponent(id)}/ws`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { url: url.toString(), token };
}

/** The document page fills the window: a top bar with the way back, the title, and the actions, then the editor. */
function Page({ title, actions, children }: { title?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="agd-page">
      <header className="agd-page__top">
        <a href="#/" className="agd-page__back">{icons.back}<span>Documents</span></a>
        {title !== undefined && <PageHeading>{title}</PageHeading>}
        <div className="agd-page__actions">{actions}</div>
      </header>
      <main className="agd-page__main">{children}</main>
    </div>
  );
}

export function EditorView({ id, go }: { id: string; go: (hash: string) => void }) {
  const { api, token, me, baseUrl, signOut } = useSession();
  const { preference, setPreference } = useTheme();
  const [title, setTitle] = useState<{ id: string; title: string } | { id: string; error: unknown }>();
  const [dialog, setDialog] = useState<"rename" | "delete" | "share" | "import">();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [attempt, setAttempt] = useState(0);
  const room = useMemo(() => roomOf(id, token, baseUrl), [id, token, baseUrl]);
  // A save on leave never makes a document, so after a delete it fails with NO_DOCUMENT and the document stays deleted.
  const load = useEditorSession(api, id, me.name, me.role === "editor", room, attempt);

  const readTitle = () => api.list().then((docs) => setTitle({ id, title: docs.find((d) => d.id === id)?.title ?? id }), (error: unknown) => setTitle({ id, error }));
  useEffect(() => void readTitle(), [api, id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const failed = load.state === "error" ? load.error : title && "error" in title ? title.error : undefined;
  if (failed !== undefined) {
    return (
      <Page>
        <div role="alert" className="agd-page__notice">
          <EmptyState title="Could not open this document" description={describe(failed)} action={<><Button onClick={() => setAttempt(attempt + 1)}>Try again</Button> <Button variant="secondary" onClick={() => go("#/")}>Back to documents</Button></>} />
        </div>
      </Page>
    );
  }
  if (load.state !== "ready" || !title || title.id !== id || !("title" in title)) return <Page><p role="status" className="agd-page__notice agd-page__status">Opening document…</p></Page>;
  // The list page has these in its top bar. A document has no side bar or top bar of the app, so they are here.
  const themes: [ThemePreference, string][] = [["system", "System theme"], ["light", "Light theme"], ["dark", "Dark theme"]];
  const more: MenuItem[] = [
    ...(editor ? [{ label: "Download Markdown", onSelect: () => downloadMarkdown(editor, title.title) }] : []),
    ...(editor && me.role === "editor" ? [{ label: "Import Markdown", onSelect: () => setDialog("import") }] : []),
    ...(editor ? ["separator" as const] : []),
    ...(me.role === "editor" ? [{ label: "Rename", onSelect: () => setDialog("rename") }, { label: "Delete", danger: true, onSelect: () => setDialog("delete") }, "separator" as const] : []),
    ...themes.map(([value, label]) => ({ label: preference === value ? `${label} (in use)` : label, onSelect: () => setPreference(value) })),
    ...(signOut ? ["separator" as const, { label: `Sign out ${me.name}`, onSelect: signOut }] : []),
  ];
  return (
    <Page
      title={title.title}
      actions={
        <>
          <Button onClick={() => setDialog("share")}>Share</Button>
          <Menu align="end" trigger={<IconButton label="More actions" icon={<MoreIcon />} variant="ghost" />} items={more} />
        </>
      }
    >
      <Boundary><Surface live={load.live} editable={me.role === "editor"} principal={me} onEditor={setEditor} /></Boundary>
      <RenameDocument id={id} current={title.title} open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(undefined)} onDone={() => void readTitle()} />
      <DeleteDocument id={id} name={title.title} open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(undefined)} onDone={() => go("#/")} />
      <ImportDialog editor={editor ?? undefined} remote={false} open={dialog === "import"} onOpenChange={(o) => !o && setDialog(undefined)} />
      <ShareDocument id={id} open={dialog === "share"} onOpenChange={(o) => !o && setDialog(undefined)} />
    </Page>
  );
}
