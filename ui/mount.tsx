// The whole app for a host page that has no React: `mount(element, options)` of `agentic-documents/ui`. It shows the
// document list and the editor against a server, with the token from a callback. The host owns sign in and the page address.
import { Button, EmptyState, ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { clientFor, describe, type Session } from "./api.js";
import { Workspace } from "./app.js";
import { routeChanged } from "./focus.js";

export interface MountOptions {
  /** The server, for example `https://docs.example.com`. The API is at `/api/v1` below it. */
  baseUrl: string;
  /** Gives the bearer token. It runs when the app opens, and again when the person picks Try again on the sign-in error. Give `update` a new function to sign in with a new token. */
  getToken: () => string | Promise<string>;
  /** Open this document first. Without it, the app opens on the document list. */
  documentId?: string;
  /** Called with the error when sign in fails: the callback gave no token, the server did not accept it, or the server cannot be reached. */
  onError?: (error: unknown) => void;
}

export interface Mounted {
  /** Use other options in the same place. A new `baseUrl` or `getToken` signs in again. */
  update(options: MountOptions): void;
  /** Remove the app. An open document saves its changes and leaves its room. */
  unmount(): void;
}

/** The callback gave no token, so the server was never called. */
class HostError extends Error {}

/** The route of an app link: `#/` is the list, `#/d/<id>` is a document. Any other link is not the app's. */
function parse(hash: string): { id: string | undefined } | undefined {
  if (hash === "#/") return { id: undefined };
  const open = /^#\/d\/([^/]+)$/.exec(hash);
  if (!open) return undefined;
  try {
    return { id: decodeURIComponent(open[1]!) };
  } catch {
    return undefined; // a bad escape
  }
}

type Auth = { state: "checking" } | { state: "error"; error: unknown } | { state: "ready"; session: Session };

function App({ baseUrl, getToken, documentId, onError }: MountOptions) {
  const [auth, setAuth] = useState<Auth>({ state: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [id, setId] = useState(documentId);
  useEffect(() => setId(documentId), [documentId]);
  useEffect(() => {
    let cancelled = false;
    setAuth({ state: "checking" });
    (async () => {
      let token: unknown;
      try {
        token = await getToken();
      } catch (e) {
        throw new HostError(`The host app could not give a token${e instanceof Error ? `: ${e.message}` : "."}`);
      }
      if (typeof token !== "string" || token === "") throw new HostError("The host app gave no token.");
      const api = clientFor(token, baseUrl);
      return { api, token, me: await api.me(), baseUrl } satisfies Session;
    })().then(
      (session) => !cancelled && setAuth({ state: "ready", session }),
      (error: unknown) => {
        if (cancelled) return;
        setAuth({ state: "error", error });
        try {
          onError?.(error);
        } catch {
          // A host callback that throws must not become an unhandled rejection.
        }
      },
    );
    return () => void (cancelled = true);
  }, [baseUrl, getToken, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useRef(id);
  shown.current = id;
  const go = useMemo(() => (hash: string) => {
    const next = parse(hash);
    if (!next) return;
    if (next.id !== shown.current) routeChanged(); // the new page puts focus on its heading
    setId(next.id);
  }, []);
  // The links of the app are `#/` routes. A click moves inside the app and leaves the address of the host page alone.
  const route = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.("a[href^='#/']");
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !parse(link.getAttribute("href")!)) return;
    event.preventDefault();
    go(link.getAttribute("href")!);
  };
  return (
    <div className="adoc-app" onClick={route}>
      {auth.state === "checking" && <p role="status" className="muted">Signing in…</p>}
      {auth.state === "error" && (
        <div role="alert" className="notice">
          <EmptyState title="Could not sign in" description={auth.error instanceof HostError ? auth.error.message : describe(auth.error)} action={<Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>} />
        </div>
      )}
      {auth.state === "ready" && <Workspace session={auth.session} id={id} go={go} />}
    </div>
  );
}

/** Render the whole app into an element, for a host page that does not use React itself. */
export function mount(element: HTMLElement, options: MountOptions): Mounted {
  const check = (o: MountOptions) => {
    if (!o || typeof o.getToken !== "function" || typeof o.baseUrl !== "string") throw new TypeError("mount needs a baseUrl and a getToken function");
    // A value with no scheme would resolve against the host page and send the token there.
    let url: URL | undefined;
    try {
      url = new URL(o.baseUrl);
    } catch {
      /* refused below */
    }
    if ((url?.protocol !== "http:" && url?.protocol !== "https:") || url.search || url.hash || url.username || url.password) {
      throw new TypeError("baseUrl must be a full http or https address with no query, fragment, or credentials");
    }
    if (o.documentId !== undefined && (typeof o.documentId !== "string" || o.documentId === "")) throw new TypeError("documentId must be a document id");
  };
  check(options);
  const root = createRoot(element);
  let open = true;
  const render = (next: MountOptions) =>
    root.render(
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <App {...next} />
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
  render(options);
  return {
    update: (next) => (check(next), open && render(next)),
    unmount: () => {
      if (!open) return;
      open = false;
      root.unmount();
    },
  };
}
