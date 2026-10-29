import { Editor, Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import type { Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import type { Peer, Status } from "agentic-realtime/client";
import { ySyncPluginKey, yCursorPlugin } from "@tiptap/y-tiptap";
import { Component, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Button, Dialog, DialogClose, EmptyState, Input, PresenceStack, usableName, type PresenceEntry } from "agentic-design/react";
import * as Y from "yjs";
import { isMachine } from "../src/kinds.js";
import { MAX_LIVE_BYTES } from "../src/limits.js";
import type { LiveSession } from "./live.js";
import { DocImage, ImageDialog } from "./image.js";
import { AgentText } from "./marks.js";
import { FormatBar } from "./toolbar.js";

/** Who uses the editor. The name shows in presence. The kind says if it is a person or an agent. */
export interface EditorPrincipal {
  kind: string;
  name: string;
}

const SAVE_AFTER_MS = 1500;

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
          caret.className = `agd-caret${peer.machine ? " agd-caret--agent" : ""}`;
          const tag = document.createElement("span");
          tag.className = "agd-caret__tag";
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
      <div role="alert" className="agd-doc agd-notice"><EmptyState title="The editor stopped" description="The document has content this page cannot show. Reload to try again." /></div>
    ) : this.props.children;
  }
}

export function Surface({ live, editable, principal: me, onEditor }: { live: LiveSession; editable: boolean; principal: EditorPrincipal; onEditor?: (editor: Editor | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor>();
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [saved, setSaved] = useState<"saved" | "saving" | "failed" | "toobig" | "removed">("saved");
  const [connection, setConnection] = useState<Status>("connecting");
  const [agentText, setAgentText] = useState(false);
  const [refused, setRefused] = useState(false); // a paste whose images did not fit
  const [linking, setLinking] = useState(false);
  const [imaging, setImaging] = useState(false);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState<string>();
  const refocus = useRef(false);
  const tell = useRef(onEditor);
  tell.current = onEditor;

  useEffect(() => {
    const fits = (slice: Slice): boolean => {
      if (live.hosted) return true;
      let bytes = 0;
      slice.content.descendants((node) => void (node.type.name === "image" && (bytes += String(node.attrs.src ?? "").length)));
      const ok = bytes === 0 || bytes + 1024 <= MAX_LIVE_BYTES - Y.encodeStateAsUpdate(live.doc).byteLength;
      setRefused(!ok);
      return ok;
    };
    const editor = new Editor({
      element: host.current!,
      editable,
      // editor.css has the base rules, so a page that forbids inline styles still shows the editor right.
      injectCSS: false,
      extensions: [
        StarterKit.configure({ undoRedo: false, underline: false, link: { openOnClick: false, autolink: true, defaultProtocol: "https", isAllowedUri: (url) => /^(https?:\/\/|mailto:)\S+$/i.test(url) } }),
        // The same rules as the engine schema (src/schema.ts): an image sits in a line, and a task item can hold a list.
        DocImage, TaskList, TaskItem.configure({ nested: true }), Table, TableRow, TableCell, TableHeader,
        Collaboration.configure({ document: live.doc, field: "default" }),
        ...(live.sync ? [carets(live.sync)] : []),
        AgentText,
      ],
      editorProps: {
        attributes: { role: "textbox", "aria-multiline": "true", "aria-label": "Document text", class: "agd-prose" },
        // A paste or a drop whose images would take the document past the room limit is refused, and the status line
        // says so. Two people who insert at the same time can still pass it; a save then says why it fails.
        handlePaste: (_view, _event, slice) => !fits(slice),
        handleDrop: (_view, _event, slice, moved) => !moved && !fits(slice), // a move inside the text adds nothing
      },
    });
    setEditor(editor);
    // The sticky bar covers the top of the window, so the caret is scrolled into view below it. The bar wraps on a narrow
    // window, so the margin follows its height.
    const bar = host.current!.closest(".agd-doc")?.querySelector<HTMLElement>(".agd-doc__bar");
    const margin = () => {
      const top = (bar?.offsetHeight ?? 56) + 16;
      editor.view.setProps({ scrollMargin: { top, bottom: 24, left: 5, right: 5 }, scrollThreshold: { top, bottom: 24, left: 0, right: 0 } });
    };
    margin();
    const watch = bar && typeof ResizeObserver !== "undefined" ? new ResizeObserver(margin) : undefined;
    if (bar) watch?.observe(bar);
    editor.on("transaction", () => (setAgentText(host.current?.querySelector(".agd-agent-text") != null), refresh()));
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
          // A document over the room limit cannot be saved until something big is removed. Say so. The editor measures
          // the state itself, so the message wording of the server does not matter.
          setSaved(Y.encodeStateAsUpdate(live.doc).byteLength > MAX_LIVE_BYTES ? "toobig" : "failed");
          timer = setTimeout(save, 5000); // try again, so a stale stored copy does not wait for the next keystroke
        },
      );
    };
    let labeled = false;
    const changed = (_update: Uint8Array, origin: unknown) => {
      if (origin !== ySyncPluginKey) return; // only changes made in this editor are labeled and saved from this tab
      // An app can change the text through the editor even when it is read only, so the label does not wait for editable.
      if (!labeled && isMachine(me.kind)) {
        // Text carries the Yjs client id of its writer. This entry ties this client to an agent, so its text is marked.
        labeled = true;
        live.doc.getArray("edits").push([{ op: "live", at: new Date().toISOString(), author: { kind: me.kind, name: me.name }, client: live.doc.clientID, inserted: 0, deleted: 0 }]);
      }
      setRefused(false);
      if (!editable || gone || live.hosted) return; // a host keeps its document itself, so there is nothing to save
      live.touch();
      setSaved("saving");
      clearTimeout(timer);
      timer = setTimeout(save, SAVE_AFTER_MS);
    };
    live.doc.on("update", changed);
    setConnection(live.status());
    const offStatus = live.onStatus(setConnection);
    return () => {
      stopped = true;
      live.doc.off("update", changed);
      offStatus();
      if (timer) clearTimeout(timer);
      offPeers?.();
      watch?.disconnect();
      editor.destroy();
    };
  }, [live, editable, me.name, me.kind]);

  // In its own effect, after the one above has its listeners and its cleanup, so content the app inserts here is labeled
  // and saved like typed text, and a callback that throws leaves nothing on the document. Each callback hears null for
  // the editor it got.
  useEffect(() => {
    if (!editor) return;
    const told = tell.current;
    told?.(editor);
    return () => told?.(null);
  }, [editor]);

  const entries: PresenceEntry[] = [{ id: "me", name: me.name, kind: isMachine(me.kind) ? "agent" : "person" }, ...peers.map(entryOf)];
  // Focus the view first, in this frame. The focus command moves focus in a later frame.
  const chain = () => (editor!.view.focus(), editor!.chain().focus());

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
    <section aria-label="Editor" className="agd-doc">
      <div className="agd-doc__bar">
        {editor && <FormatBar editor={editor} editable={editable} onLink={openLink} onImage={() => setImaging(true)} />}
        <div className="agd-doc__meta">
          <PresenceStack entries={entries} label="People and agents here" />
          <span role="status" className="agd-muted">
            {!editable ? "Read only. " : ""}
            {refused ? "The images do not fit in this document, so they were not added. " : ""}
            {connection === "disconnected" ? "Offline: changes are kept and sync when you are back. " : ""}
            {live.hosted ? "" : saved === "saving" ? "Saving…" : saved === "failed" ? "Not saved. Will try again." : saved === "toobig" ? "Not saved: the document is over the size limit. Remove some content to save it." : saved === "removed" ? "This document was removed. Your changes are not saved." : "Saved"}
          </span>
        </div>
      </div>
      <div className="agd-paper">
        <div ref={host} className="agd-paper__text" />
        <p className="agd-muted agd-legend">
          {agentText ? <><span className="agd-agent-text">Dotted text</span> was written by an agent.</> : "Text that an agent writes shows with a dotted underline."}
        </p>
      </div>
      <Dialog open={linking} onOpenChange={setLinking} title="Link" description="Leave it empty to remove the link.">
        <form className="agd-form" onSubmit={(e) => (e.preventDefault(), applyLink())}>
          <Input label="Address" value={href} onChange={(e) => setHref(e.target.value)} error={linkError} placeholder="https://" autoComplete="off" />
          <div className="agd-form-actions">
            <DialogClose asChild><Button type="button" variant="secondary">Cancel</Button></DialogClose>
            <Button type="submit">Apply</Button>
          </div>
        </form>
      </Dialog>
      <ImageDialog editor={editor} doc={live.doc} open={imaging} onOpenChange={setImaging} />
    </section>
  );
}
