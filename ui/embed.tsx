// The editor for an app that embeds it: `agentic-documents/ui`. The app gives a document id, a client, the principal who
// uses the editor, and an optional live room. Or it gives its own Yjs document as `host`. React and react-dom are peer
// dependencies.
import { Button, EmptyState } from "agentic-design/react";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PRINCIPAL_KINDS, type PrincipalKind } from "agentic-identity";
import { checkHost, hostSession, openSession, type EditorClient, type EditorRoom, type HostDocument, type LiveSession, type RoomPresence } from "./live.js";
import { Boundary, Surface, isRemoved, type EditorExtras } from "./editor.js";

export type { Editor, EditorClient, EditorExtras, EditorRoom, HostDocument, LiveSession, RoomPresence };
export type { BubbleAction } from "./bubble.js";
export type { SlashItem } from "./slash.js";
export { editorMarkdown, setEditorMarkdown } from "./transfer.js";

/** Who uses the editor. The server still checks every write against its own token. */
export interface EmbedPrincipal {
  kind: PrincipalKind;
  name: string;
  /** Only `editor` can change the text. Any other value, or no value, opens it read only. */
  role?: "editor" | "viewer";
}

export interface DocumentEditorOptions extends EditorExtras {
  /** The document id. */
  id: string;
  /** Loads and saves the document. A client from `createClient` in `agentic-documents/client` works. Not needed with `host`. */
  client?: EditorClient;
  principal: EmbedPrincipal;
  /** The live room. With one, people and agents edit together and see each other. Without one, the editor saves alone. Not allowed with `host`. */
  room?: EditorRoom;
  /**
   * A Yjs document that the app keeps in its own room. The editor binds to it and does not load, save, join a room, or
   * close it. The app does all of that.
   */
  host?: HostDocument;
  /** Called with the editor when it is ready, and with null when it goes. The app can read the selection or the JSON, or insert content. */
  onEditor?: (editor: Editor | null) => void;
  /** Called when the document cannot open, with the error. */
  onError?: (error: unknown) => void;
  /** Called when the editor closes a document, with a promise that settles when the last save and the leave are done. It rejects when that save fails. */
  onLeave?: (done: Promise<void>) => void;
}

/** A principal must have a known kind and a name. A missing kind is an error, never a default. */
function checkPrincipal(principal: EmbedPrincipal): void {
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.name !== "string" || principal.name.trim() === "") {
    throw new TypeError(`the editor needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  }
}

/** The editor needs a client, or a host document and no room of its own. */
function checkOptions(options: DocumentEditorOptions): void {
  checkPrincipal(options.principal);
  if (options.host !== undefined) {
    checkHost(options.host);
    if (options.room !== undefined) throw new TypeError("the editor takes a room or a host document, not both");
  } else if (typeof options.client?.state !== "function" || typeof options.client.checkpoint !== "function") {
    throw new TypeError("the editor needs a client from createClient, or a host document");
  }
}

export type SessionState = { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; live: LiveSession };

/**
 * Open a document for an editor, and close it when the component goes. On leave it saves first, but only when this tab
 * changed something and may write. A save never makes a document, so a removed document stays removed. `onLeave` gets a
 * promise that settles when the leave is done. It rejects when the save fails. With no `onLeave`, a failure is dropped.
 */
export function useEditorSession(client: EditorClient, id: string, name: string, editable: boolean, room: EditorRoom | undefined, attempt: number, onLeave?: (done: Promise<void>) => void): SessionState {
  const [load, setLoad] = useState<SessionState>({ state: "loading" });
  // The room is an object the app may make on each render. Only its values decide when to join again.
  const roomKey = room ? JSON.stringify([room.url, room.token ?? ""]) : "";
  const roomRef = useRef(room);
  roomRef.current = room;
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  useEffect(() => {
    let cancelled = false;
    let live: LiveSession | undefined;
    setLoad({ state: "loading" });
    openSession(client, id, name, roomRef.current).then(
      (found) => {
        live = found;
        if (cancelled) return void found.close();
        setLoad({ state: "ready", live: found });
      },
      (error: unknown) => !cancelled && setLoad({ state: "error", error }),
    );
    return () => {
      cancelled = true;
      const open = live;
      if (!open) return;
      const done = (async () => {
        try {
          if (editable && open.dirty) await open.save();
        } finally {
          await open.close();
        }
      })();
      if (leaveRef.current) leaveRef.current(done);
      else done.catch(() => undefined);
    };
  }, [client, id, name, editable, roomKey, room?.WebSocket, attempt]);
  return load;
}

const describe = (error: unknown): string => {
  if (isRemoved(error)) return "This document does not exist. It may have been removed.";
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "UNAUTHENTICATED") return "The server did not accept the token.";
  if (code === "FORBIDDEN") return "You may not open this document.";
  return error instanceof Error ? error.message : "Something went wrong.";
};

/** The editor on a document the app keeps. */
function HostedEditor({ host, principal, onEditor, extras }: { host: HostDocument; principal: EmbedPrincipal; onEditor?: (editor: Editor | null) => void; extras: EditorExtras }) {
  // The app may make the host object on each render. Only the document and the presence decide when to bind again.
  const latest = useRef(host);
  latest.current = host;
  const live = useMemo(
    () => hostSession({ doc: host.doc, presence: host.presence, status: () => latest.current.status?.() ?? "connected", onStatus: (listener) => latest.current.onStatus?.(listener) ?? (() => {}) }),
    [host.doc, host.presence],
  );
  return (
    <Boundary>
      <Surface live={live} editable={principal.role === "editor"} principal={principal} onEditor={onEditor} extras={extras} />
    </Boundary>
  );
}

/** The editor for one document, with its toolbar, presence, and save state. */
export function DocumentEditor(options: DocumentEditorOptions) {
  checkOptions(options);
  const extras: EditorExtras = { slashItems: options.slashItems, bubbleActions: options.bubbleActions, extensions: options.extensions };
  return options.host ? <HostedEditor host={options.host} principal={options.principal} onEditor={options.onEditor} extras={extras} /> : <StoredEditor {...options} client={options.client!} />;
}

/** The editor on a document that it loads and saves with the client. */
function StoredEditor({ id, client, principal, room, onError, onLeave, onEditor, slashItems, bubbleActions, extensions }: DocumentEditorOptions & { client: EditorClient }) {
  const editable = principal.role === "editor";
  const [attempt, setAttempt] = useState(0);
  const load = useEditorSession(client, id, principal.name, editable, room, attempt, onLeave);
  const reported = useRef<unknown>(undefined);
  useEffect(() => {
    if (load.state === "error" && reported.current !== load.error) {
      reported.current = load.error;
      onError?.(load.error);
    }
  }, [load, onError]);

  if (load.state === "loading") return <p role="status" className="agd-doc agd-muted">Opening document…</p>;
  if (load.state === "error") {
    return (
      <div role="alert" className="agd-doc agd-notice">
        <EmptyState title="Could not open this document" description={describe(load.error)} action={<Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>} />
      </div>
    );
  }
  return (
    <Boundary>
      <Surface live={load.live} editable={editable} principal={principal} onEditor={onEditor} extras={{ slashItems, bubbleActions, extensions }} />
    </Boundary>
  );
}

export interface MountedEditor {
  /** Show another document, principal, room, or host document in the same place. A bad option throws and keeps the editor as it is. */
  update(options: DocumentEditorOptions): void;
  /** Remove the editor. It saves this tab's changes, then leaves the room. The promise rejects when that save fails. */
  unmount(): Promise<void>;
}

/** Render the editor into an element, for an app that does not use React itself. */
export function mountEditor(element: HTMLElement, options: DocumentEditorOptions): MountedEditor {
  checkOptions(options);
  const root = createRoot(element);
  const leaving = new Set<Promise<void>>();
  const track = (done: Promise<void>) => {
    leaving.add(done);
    void done.catch(() => undefined).finally(() => leaving.delete(done));
  };
  const render = (next: DocumentEditorOptions) =>
    root.render(<DocumentEditor key={next.id} {...next} onLeave={(done) => (track(done), next.onLeave?.(done))} />);
  render(options);
  return {
    update: (next) => (checkOptions(next), render(next)),
    unmount: async () => {
      root.unmount(); // runs the cleanup now, so every leave is tracked before the wait
      await Promise.all(leaving);
    },
  };
}
