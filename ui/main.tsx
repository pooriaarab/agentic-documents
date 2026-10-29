import { StrictMode, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Button, Input, ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import type { Me } from "../src/client.js";
import { clientFor, describe, forgetToken, saveToken, savedToken, type Session } from "./api.js";
import { routeChanged } from "./focus.js";
import { Workspace } from "./app.js";
import "agentic-design/styles.css";
import "./editor.css";
import "./app.css";

const useRoute = (): [string, (hash: string) => void] => {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => (routeChanged(), setHash(location.hash || "#/"));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [hash, (next) => (location.hash = next)];
};

function SignIn({ onSignedIn }: { onSignedIn: (token: string, me: Me) => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onSignedIn(token.trim(), await clientFor(token.trim()).me());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin">
      <h1>Sign in</h1>
      <p className="muted">Paste an access token for this server. The token stays in this tab.</p>
      <form onSubmit={submit} className="form">
        <Input label="Access token" type="password" value={token} onChange={(e) => setToken(e.target.value)} error={error} autoComplete="off" required />
        <Button type="submit" loading={busy}>Sign in</Button>
      </form>
    </main>
  );
}

function App() {
  const [hash, go] = useRoute();
  const [auth, setAuth] = useState<{ token: string; me: Me } | "checking" | null>(savedToken() ? "checking" : null);
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    const token = savedToken();
    if (!token) return;
    clientFor(token).me().then(
      (me) => setAuth({ token, me }),
      (e: unknown) => (forgetToken(), setProblem(describe(e)), setAuth(null)),
    );
  }, []);
  const signOut = useCallback(() => (forgetToken(), setAuth(null), (location.hash = "#/")), []);
  const session = useMemo<Session | null>(() => (auth && auth !== "checking" ? { api: clientFor(auth.token), token: auth.token, me: auth.me, baseUrl: location.origin, signOut } : null), [auth, signOut]);
  if (auth === "checking") return <p role="status" className="signin muted">Checking your token…</p>;
  if (!session) return <>{problem && <p role="alert" className="signin form-error">{problem}</p>}<SignIn onSignedIn={(token, me) => (saveToken(token), setAuth({ token, me }))} /></>;
  const open = /^#\/d\/([^/]+)$/.exec(hash);
  return <Workspace session={session} id={open ? decodeURIComponent(open[1]) : undefined} go={go} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
