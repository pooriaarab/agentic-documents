import { Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import type { Peer, Status } from "agentic-realtime/client";
import { ySyncPluginKey, yCursorPlugin } from "@tiptap/y-tiptap";
import { Component, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogClose, EmptyState, Input, PresenceStack, Toolbar, ToolbarButton, ToolbarSeparator, usableName, type PresenceEntry } from "agentic-design/react";
import { isMachine } from "../src/kinds.js";
import type { LiveSession } from "./live.js";
import { AgentText } from "./marks.js";

/** Who uses the editor. The name shows in presence. The kind says if it is a person or an agent. */
export interface EditorPrincipal {
  kind: string;
  name: string;
}

export const SAVE_AFTER_MS = 1500;

const entryOf = (peer: Peer): PresenceEntry => ({ id: String(peer.clientId), name: usableName(peer.name) ?? "Unnamed", kind: peer.machine ? "agent" : "person" });

/** A removed document. The check reads the code, so an error from any copy of the client counts. */
export const isRemoved = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "NO_DOCUMENT";

/**
 * The caret of another person or agent. The name and the Agent tag come from the peer that the server stamped for that
 * awareness client id, never from what the peer says about itself. A caret with no such peer is not drawn.
 */
function carets(sync: NonNullable<LiveSession["sync"]>) {
  return Extension.create({
    name: "remoteCarets",
    addProseMirrorPlugins: () => [
      yCursorPlugin(sync.awareness, {
        cursorBuilder: (_user, clientId) => {
          const caret = document.createElement("span");
          const peer = sync.peers.find((p) => p.clientId === clientId);
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

export class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert" className="adoc notice"><EmptyState title="The editor stopped" description="The document has content this page cannot show. Reload to try again." /></div>
    ) : this.props.children;
  }
}

export function Surface({ live, editable, principal: me, onEditor }: { live: LiveSession; editable: boolean; principal: EditorPrincipal; onEditor?: (editor: Editor | null) => void }) {
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
  const tell = useRef(onEditor);
  tell.current = onEditor;

  useEffect(() => {
    const editor = new Editor({
      element: host.current!,
      editable,
      // editor.css has the base rules, so a page that forbids inline styles still shows the editor right.
      injectCSS: false,
      extensions: [
        StarterKit.configure({ undoRedo: false, underline: false, link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url) => /^(https?:\/\/|mailto:)\S+$/i.test(url) } }),
        Image, TaskList, TaskItem, Table, TableRow, TableCell, TableHeader,
        Collaboration.configure({ document: live.doc, field: "default" }),
        ...(live.sync ? [carets(live.sync)] : []),
        AgentText,
      ],
      editorProps: { attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "Document text", class: "prose" } },
    });
    setEditor(editor);
    editor.on("transaction", () => (setAgentText(host.current?.querySelector(".agent-text") != null), refresh()));
    const offPeers = live.sync?.onPeers(setPeers);
    setPeers(live.sync?.peers ?? []);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false; // set when the editor goes, so a late result starts nothing
    let gone = false; // set when someone deleted the document
    const save = () => {
      timer = undefined;
      setSaved("saving");
      live.save().then(
        () => !stopped && setSaved("saved"),
        (error: unknown) => {
          if (stopped) return;
          if (isRemoved(error)) {
            gone = true;
            editor.setEditable(false); // text that can never be saved is not left open for typing
            return setSaved("removed");
          }
          setSaved("failed");
          timer = setTimeout(save, 5000); // try again, so a stale stored copy does not wait for the next keystroke
        },
      );
    };
    let labeled = false;
    const changed = (_update: Uint8Array, origin: unknown) => {
      if (editable && !gone && origin === ySyncPluginKey) { // only changes made in this editor are saved from this tab
        if (!labeled && isMachine(me.kind)) {
          // Text carries the Yjs client id of its writer. This entry ties this client to an agent, so its text is marked.
          labeled = true;
          live.doc.getArray("edits").push([{ op: "live", at: new Date().toISOString(), author: { kind: me.kind, name: me.name }, client: live.doc.clientID, inserted: 0, deleted: 0 }]);
        }
        if (live.hosted) return; // the app keeps the document, so there is nothing to save
        live.touch();
        setSaved("saving");
        clearTimeout(timer);
        timer = setTimeout(save, SAVE_AFTER_MS);
      }
    };
    live.doc.on("update", changed);
    setConnection(live.status());
    const offStatus = live.onStatus(setConnection);
    // Last, so content the app inserts from onEditor is labeled and saved like typed text.
    tell.current?.(editor);
    return () => {
      stopped = true;
      live.doc.off("update", changed);
      offStatus();
      if (timer) clearTimeout(timer);
      offPeers?.();
      tell.current?.(null);
      editor.destroy();
    };
  }, [live, editable, me.name, me.kind]);

  const entries: PresenceEntry[] = [{ id: "me", name: me.name, kind: isMachine(me.kind) ? "agent" : "person" }, ...peers.map(entryOf)];
  const pressed = (name: string, attrs?: object) => editor?.isActive(name, attrs) ?? false;
  // Focus the view first, in this frame. The focus command moves focus in a later frame, so a key typed right after a
  // toolbar click would go to the button and be lost.
  const chain = () => (editor!.view.focus(), editor!.chain().focus());
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
    // Put the caret after the link. A selection left open is replaced by the next key, and the key can arrive before the
    // editor has read the caret that a caret key set, so a quick Enter would delete the words that got the link.
    // Text typed there must not join the link, and a caret with no words selected keeps the link it just got.
    if (editor && !editor.state.selection.empty) editor.chain().setTextSelection(editor.state.selection.to).unsetMark("link").run();
    refocus.current = true;
    setLinking(false);
  }
  // The dialog gives focus back to the toolbar button when it closes. After Apply, writing goes on in the text.
  useEffect(() => {
    if (linking || !refocus.current) return;
    refocus.current = false;
    // The dialog may give focus back after this runs, so try a few times until the text has it.
    // Focus the view itself. The focus command moves focus in a later frame and writes the old selection back then,
    // over a caret that the person has moved since.
    let tries = 0;
    const timer = setInterval(() => {
      if (editor?.isFocused || ++tries > 10) return clearInterval(timer);
      editor?.view.focus();
    }, 40);
    return () => clearInterval(timer);
  }, [linking, editor]);

  return (
    <section aria-label="Editor" className="adoc">
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
            {live.hosted ? "" : saved === "saving" ? "Saving…" : saved === "failed" ? "Not saved. Will try again." : saved === "removed" ? "This document was removed. Your changes are not saved." : "Saved"}
          </span>
        </div>
      </div>
      <div ref={host} className="editor-host" />
      <p className="muted legend">
        {agentText ? <><span className="agent-text">Dotted text</span> was written by an agent.</> : "Text that an agent writes shows with a dotted underline."}
      </p>
      <Dialog open={linking} onOpenChange={setLinking} title="Link" description="Leave it empty to remove the link.">
        <form className="adoc form" onSubmit={(e) => (e.preventDefault(), applyLink())}>
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
