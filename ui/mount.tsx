// The whole app for a host page that has no React: `mount(element, options)` of `agentic-documents/ui`. It shows the
// document list and the editor against a server, with the token from a callback. The host owns sign in and the page address.
import { Button, EmptyState, ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { clientFor, describe, type Session } from "./api.js";
import { Workspace } from "./app.js";

export interface MountOptions {
  /** The server, for example `https://docs.example.com`. The API is at `/api/v1` below it. */
  baseUrl: string;
  /** Gives the bearer token. It runs when the app opens and when the person picks Try again, so it can fetch a fresh token. */
  getToken: () => string | Promise<string>;
  /** Open this document first. Without it, the app opens on the document list. */
  documentId?: string;
  /** Called with the error when the server does not accept the token or cannot be reached. */
  onError?: (error: unknown) => void;
}

export interface Mounted {
  /** Use other options in the same place. A new `baseUrl` or `getToken` signs in again. */
  update(options: MountOptions): void;
  /** Remove the app. An open document saves its changes and leaves its room. */
  unmount(): void;
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
      const token = await getToken();
      if (typeof token !== "string" || token === "") throw new TypeError("getToken must give a token");
      const api = clientFor(token, baseUrl);
      return { api, token, me: await api.me(), baseUrl } satisfies Session;
    })().then(
      (session) => !cancelled && setAuth({ state: "ready", session }),
      (error: unknown) => !cancelled && (setAuth({ state: "error", error }), onError?.(error)),
    );
    return () => void (cancelled = true);
  }, [baseUrl, getToken, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = useMemo(() => (hash: string) => {
    const open = /^#\/d\/([^/]+)$/.exec(hash);
    setId(open ? decodeURIComponent(open[1]!) : undefined);
  }, []);
  // The links of the app are `#/` routes. A click moves inside the app and leaves the address of the host page alone.
  const route = (event: MouseEvent) => {
    const link = (event.target as Element).closest?.("a[href^='#/']");
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(link.getAttribute("href")!);
  };
  return (
    <div className="adoc-app" onClick={route}>
      {auth.state === "checking" && <p role="status" className="muted">Signing in…</p>}
      {auth.state === "error" && (
        <div role="alert" className="notice">
          <EmptyState title="Could not sign in" description={describe(auth.error)} action={<Button onClick={() => setAttempt(attempt + 1)}>Try again</Button>} />
        </div>
      )}
      {auth.state === "ready" && <Workspace session={auth.session} id={id} go={go} />}
    </div>
  );
}

/** Render the whole app into an element, for a host page that does not use React itself. */
export function mount(element: HTMLElement, options: MountOptions): Mounted {
  const check = (o: MountOptions) => {
    if (!o || typeof o.baseUrl !== "string" || o.baseUrl === "" || typeof o.getToken !== "function") throw new TypeError("mount needs a baseUrl and a getToken function");
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
