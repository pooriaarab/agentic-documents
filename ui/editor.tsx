import { Editor } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import type { Peer, Status } from "agentic-realtime/client";
import { Extension } from "@tiptap/core";
import { ySyncPluginKey, yCursorPlugin } from "@tiptap/y-tiptap";
import { Component, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogClose, EmptyState, Input, PresenceStack, Toolbar, ToolbarButton, ToolbarSeparator, usableName, type PresenceEntry } from "agentic-design/react";
import { DocsApiError } from "../src/client.js";
import { describe, isMachine, useSession } from "./api.js";
import { PageHeading } from "./focus.js";
import { DeleteDocument, RenameDocument, ShareDocument } from "./dialogs.js";
import { openSession, type LiveSession } from "./live.js";
import { AgentText } from "./marks.js";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; live: LiveSession; title: string };
const SAVE_AFTER_MS = 1500;

const entryOf = (peer: Peer): PresenceEntry => ({ id: String(peer.clientId), name: usableName(peer.name) ?? "Unnamed", kind: peer.machine ? "agent" : "person" });

/**
 * The caret of another person or agent. The name and the Agent tag come from the peer that the server stamped for that
 * awareness client id, never from what the peer says about itself. A caret with no such peer is not drawn.
 */
function carets(live: LiveSession) {
  return Extension.create({
    name: "remoteCarets",
    addProseMirrorPlugins: () => [
      yCursorPlugin(live.sync.awareness, {
        cursorBuilder: (_user, clientId) => {
          const caret = document.createElement("span");
          const peer = live.sync.peers.find((p) => p.clientId === clientId);
          if (!peer) return caret;
          caret.className = `caret${peer.machine ? " caret--agent" : ""}`;
          const tag = document.createElement("span");
          tag.className = "caret__tag";
          tag.textContent = `${usableName(peer.name) ?? "Unnamed"}${peer.machine ? " · Agent" : ""}`;
          caret.append(tag);
          return caret;
        },
        selectionBuilder: () => ({}),
      }),
    ],
  });
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="notice"><EmptyState title="The editor stopped" description="The document has content this page cannot show. Reload to try again." /></div>
    ) : this.props.children;
  }
}

export function EditorView({ id, go }: { id: string; go: (hash: string) => void }) {
  const { api, token, me } = useSession();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [dialog, setDialog] = useState<"rename" | "delete" | "share">();
  const [attempt, setAttempt] = useState(0);
  const removed = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let live: LiveSession | undefined;
    setLoad({ state: "loading" });
    (async () => {
      try {
        const docs = await api.list();
        const found = await openSession(api, token, id, me.name);
        live = found;
        if (cancelled) return void (await found.close());
        setLoad({ state: "ready", live: found, title: docs.find((d) => d.id === id)?.title ?? id });
      } catch (e) {
        if (!cancelled) setLoad({ state: "error", message: describe(e) });
      }
    })();
    return () => {
      cancelled = true;
      // Save on leave only when this tab changed something. A save never makes a document, so a delete stays deleted.
      if (live) void (removed.current || me.role === "viewer" || !live.dirty ? Promise.resolve() : live.save().catch(() => undefined)).finally(() => live?.close());
    };
  }, [api, token, id, me.name, me.role, attempt]);

  if (load.state === "loading") return <p role="status" className="muted">Opening document…</p>;
  if (load.state === "error") {
    return (
      <div role="alert" className="notice">
        <EmptyState title="Could not open this document" description={load.message} action={<><Button onClick={() => setAttempt(attempt + 1)}>Try again</Button> <Button variant="secondary" onClick={() => go("#/")}>Back to documents</Button></>} />
      </div>
    );
  }
  const { live, title } = load;
  return (
    <>
      <div className="page-head">
        <PageHeading>{title}</PageHeading>
        <div className="page-actions">
          {me.role === "editor" && <Button variant="secondary" onClick={() => setDialog("rename")}>Rename</Button>}
          <Button onClick={() => setDialog("share")}>Share</Button>
          {me.role === "editor" && <Button variant="danger" onClick={() => setDialog("delete")}>Delete</Button>}
        </div>
      </div>
      <Boundary><Surface live={live} editable={me.role === "editor"} /></Boundary>
      <RenameDocument id={id} current={title} open={dialog === "rename"} onOpenChange={(o) => !o && setDialog(undefined)} onDone={() => void api.list().then((docs) => setLoad((l) => (l.state === "ready" ? { ...l, title: docs.find((d) => d.id === id)?.title ?? id } : l)))} />
      <DeleteDocument id={id} name={title} open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(undefined)} onDone={() => ((removed.current = true), go("#/"))} />
      <ShareDocument id={id} open={dialog === "share"} onOpenChange={(o) => !o && setDialog(undefined)} />
    </>
  );
}

function Surface({ live, editable }: { live: LiveSession; editable: boolean }) {
  const { me } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor>();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [saved, setSaved] = useState<"saved" | "saving" | "failed" | "removed">("saved");
  const [connection, setConnection] = useState<Status>("connecting");
  const [agentText, setAgentText] = useState(false);
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState<string>();
  const refocus = useRef(false);

  useEffect(() => {
    const editor = new Editor({
      element: host.current!,
      editable,
      extensions: [
        StarterKit.configure({ undoRedo: false, underline: false, link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url) => /^(https?:\/\/|mailto:)\S+$/i.test(url) } }),
        Image, TaskList, TaskItem, Table, TableRow, TableCell, TableHeader,
        Collaboration.configure({ document: live.doc, field: "default" }),
        carets(live),
        AgentText,
      ],
      editorProps: { attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "Document text", class: "prose" } },
    });
    setEditor(editor);
    editor.on("transaction", () => (setAgentText(host.current?.querySelector(".agent-text") != null), refresh()));
    const offPeers = live.sync.onPeers(setPeers);
    setPeers(live.sync.peers);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      timer = undefined;
      setSaved("saving");
      live.save().then(
        () => setSaved("saved"),
        (error: unknown) => {
          if (error instanceof DocsApiError && error.code === "NO_DOCUMENT") return setSaved("removed"); // someone deleted it: stop saving
          setSaved("failed");
          timer = setTimeout(save, 5000); // try again, so a stale stored copy does not wait for the next keystroke
        },
      );
    };
    const changed = (_update: Uint8Array, origin: unknown) => {
      if (editable && origin === ySyncPluginKey) { // only changes made in this editor are saved from this tab
        live.dirty = true;
        setSaved("saving");
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_AFTER_MS);
      }
    };
    live.doc.on("update", changed);
    setConnection(live.status());
    const offStatus = live.onStatus(setConnection);
    return () => {
      live.doc.off("update", changed);
      offStatus();
      if (timer) clearTimeout(timer);
      offPeers();
      editor.destroy();
    };
  }, [live, editable, me.name]);

  const entries: PresenceEntry[] = [{ id: "me", name: me.name, kind: isMachine(me.kind) ? "agent" : "person" }, ...peers.map(entryOf)];
  const pressed = (name: string, attrs?: object) => editor?.isActive(name, attrs) ?? false;
  const chain = () => editor!.chain().focus();
  const glyph = (text: string, style?: "b" | "i") => <span aria-hidden="true" className={`glyph glyph--${style ?? "plain"}`}>{text}</span>;
  // An icon with no text, so the accessible name of its button has nothing visible to match.
  const listIcon = (numbered: boolean) => (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="1.25em" height="1.25em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 5h9M8 10h9M8 15h9" />
      {numbered ? <path d="M3 4.5l1-.5v4M3 11.5h2l-2 2.5h2.2" strokeLinejoin="round" /> : <path d="M3.5 5h.01M3.5 10h.01M3.5 15h.01" strokeWidth="2.6" />}
    </svg>
  );
  const tool = (label: string, icon: ReactNode, active: boolean, run: () => void) => <ToolbarButton label={label} icon={icon} pressed={active} onClick={run} disabled={!editable} />;

  function openLink() {
    setHref((editor?.getAttributes("link").href as string | undefined) ?? "");
    setLinkError(undefined);
    setLinking(true);
  }
  function applyLink() {
    const value = href.trim();
    if (value === "") chain().extendMarkRange("link").unsetLink().run();
    else if (!/^(https?:\/\/|mailto:)\S+$/i.test(value)) return setLinkError("Use a web address that starts with https:// or http://, or a mailto: address.");
    else chain().extendMarkRange("link").setLink({ href: value }).run();
    refocus.current = true;
    setLinking(false);
  }
  // The dialog gives focus back to the toolbar button when it closes. After Apply, writing goes on in the text.
  useEffect(() => {
    if (linking || !refocus.current) return;
    refocus.current = false;
    // The dialog may give focus back after this runs, so try a few times until the text has it.
    let tries = 0;
    const timer = setInterval(() => {
      if (editor?.isFocused || ++tries > 10) return clearInterval(timer);
      editor?.commands.focus();
    }, 40);
    return () => clearInterval(timer);
  }, [linking, editor]);

  return (
    <section aria-label="Editor">
      <div className="editor-bar">
        <Toolbar label="Formatting">
          {tool("Bold", glyph("B", "b"), pressed("bold"), () => chain().toggleBold().run())}
          {tool("Italic", glyph("I", "i"), pressed("italic"), () => chain().toggleItalic().run())}
          <ToolbarSeparator />
          {tool("H1 heading", glyph("H1"), pressed("heading", { level: 1 }), () => chain().toggleHeading({ level: 1 }).run())}
          {tool("H2 heading", glyph("H2"), pressed("heading", { level: 2 }), () => chain().toggleHeading({ level: 2 }).run())}
          <ToolbarSeparator />
          {tool("Bulleted list", listIcon(false), pressed("bulletList"), () => chain().toggleBulletList().run())}
          {tool("Numbered list", listIcon(true), pressed("orderedList"), () => chain().toggleOrderedList().run())}
          <ToolbarSeparator />
          {tool("Link", glyph("↗"), pressed("link"), openLink)}
        </Toolbar>
        <div className="editor-meta">
          <PresenceStack entries={entries} label="People and agents here" />
          <span role="status" className="muted">
            {!editable ? "Read only. " : ""}
            {connection === "disconnected" ? "Offline: changes are kept and sync when you are back. " : ""}
            {saved === "saving" ? "Saving…" : saved === "failed" ? "Not saved. Will try again." : saved === "removed" ? "This document was removed. Your changes are not saved." : "Saved"}
          </span>
        </div>
      </div>
      <div ref={host} className="editor-host" />
      <p className="muted legend">
        {agentText ? <><span className="agent-text">Dotted text</span> was written by an agent.</> : "Text that an agent writes shows with a dotted underline."}
      </p>
      <Dialog open={linking} onOpenChange={setLinking} title="Link" description="Leave it empty to remove the link.">
        <form className="form" onSubmit={(e) => (e.preventDefault(), applyLink())}>
          <Input label="Address" value={href} onChange={(e) => setHref(e.target.value)} error={linkError} placeholder="https://" autoComplete="off" />
          <div className="form-actions">
            <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
            <Button type="submit">Apply</Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
