// The editor for an app that embeds it: `agentic-documents/ui`. The app gives a document id, a client, the principal who
// uses the editor, and an optional live room. React and react-dom are peer dependencies.
import { Button, EmptyState } from "agentic-design/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/kinds.js";
import { openSession, type EditorClient, type EditorRoom, type LiveSession } from "./live.js";
import { Boundary, Surface, isRemoved } from "./editor.js";

export type { EditorClient, EditorRoom, LiveSession };

/** Who uses the editor. The server still checks every write against its own token. */
export interface EmbedPrincipal {
  kind: PrincipalKind;
  name: string;
  /** `viewer` opens the text read only. Any value other than `editor` or no value counts as `viewer`. */
  role?: "editor" | "viewer";
}

export interface DocumentEditorOptions {
  /** The document id. */
  id: string;
  /** Loads and saves the document. A client from `createClient` in `agentic-documents/client` works. */
  client: EditorClient;
  principal: EmbedPrincipal;
  /** The live room. With one, people and agents edit together and see each other. Without one, the editor saves alone. */
  room?: EditorRoom;
  /** Called when the document cannot open, with the error. */
  onError?: (error: unknown) => void;
}

/** A principal must have a known kind and a name. A missing kind is an error, never a default. */
function checkPrincipal(principal: EmbedPrincipal): void {
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.name !== "string" || principal.name.trim() === "") {
    throw new TypeError(`the editor needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  }
}

export type SessionState = { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; live: LiveSession };

/**
 * Open a document for an editor, and close it when the component goes. On leave it saves first, but only when this tab
 * changed something and may write. A save never makes a document, so a removed document stays removed.
 */
export function useEditorSession(client: EditorClient, id: string, name: string, editable: boolean, room: EditorRoom | undefined, attempt: number): SessionState {
  const [load, setLoad] = useState<SessionState>({ state: "loading" });
  // The room is an object the app may make on each render. Only its values decide when to join again.
  const roomKey = room ? JSON.stringify([room.url, room.token ?? ""]) : "";
  const roomRef = useRef(room);
  roomRef.current = room;
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
      if (live) void (!editable || !live.dirty ? Promise.resolve() : live.save().catch(() => undefined)).finally(() => live?.close());
    };
  }, [client, id, name, editable, roomKey, attempt]);
  return load;
}

const describe = (error: unknown): string => {
  if (isRemoved(error)) return "This document does not exist. It may have been removed.";
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "UNAUTHENTICATED") return "The server did not accept the token.";
  if (code === "FORBIDDEN") return "You may not open this document.";
  return error instanceof Error ? error.message : "Something went wrong.";
};

/** The editor for one document, with its toolbar, presence, and save state. */
export function DocumentEditor({ id, client, principal, room, onError }: DocumentEditorOptions) {
  checkPrincipal(principal);
  const editable = principal.role === undefined || principal.role === "editor";
  const [attempt, setAttempt] = useState(0);
  const load = useEditorSession(client, id, principal.name, editable, room, attempt);
  const reported = useRef<unknown>(undefined);
  useEffect(() => {
    if (load.state === "error" && reported.current !== load.error) {
      reported.current = load.error;
      onError?.(load.error);
    }
  }, [load, onError]);

  if (load.state === "loading") return <p role="status" className="adoc muted">Opening document…</p>;
  if (load.state === "error") {
    return (
      <div role="alert" className="adoc notice">
        <EmptyState title="Could not open this document" description={describe(load.error)} action={<Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>} />
      </div>
    );
  }
  return (
    <Boundary>
      <Surface live={load.live} editable={editable} principal={principal} />
    </Boundary>
  );
}

export interface MountedEditor {
  /** Show another document, principal, or room in the same place. */
  update(options: DocumentEditorOptions): void;
  /** Remove the editor. It saves this tab's changes first, then leaves the room. */
  unmount(): void;
}

/** Render the editor into an element, for an app that does not use React itself. */
export function mountEditor(element: HTMLElement, options: DocumentEditorOptions): MountedEditor {
  checkPrincipal(options.principal);
  const root = createRoot(element);
  const render = (next: DocumentEditorOptions) => root.render(<DocumentEditor key={next.id} {...next} />);
  render(options);
  return {
    update: (next) => (checkPrincipal(next.principal), render(next)),
    unmount: () => root.unmount(),
  };
}
