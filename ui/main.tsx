import { StrictMode, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, Button, Input, Select, SidebarNav, ThemeProvider, ToastProvider, TooltipProvider, useTheme, type ThemePreference } from "agentic-design/react";
import type { Me } from "../src/client.js";
import { clientFor, describe, forgetToken, SessionContext, saveToken, savedToken, type Session } from "./api.js";
import { EditorView } from "./editor.js";
import { routeChanged } from "./focus.js";
import { DocumentList } from "./list.js";
import "agentic-design/styles.css";
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

function ThemePick() {
  const { preference, setPreference } = useTheme();
  return (
    <Select label="Theme" hideLabel value={preference} onChange={(e) => setPreference(e.target.value as ThemePreference)}>
      <option value="system">Theme: System</option>
      <option value="light">Theme: Light</option>
      <option value="dark">Theme: Dark</option>
    </Select>
  );
}

function Signed({ session }: { session: Session }) {
  const [hash, go] = useRoute();
  const open = /^#\/d\/([^/]+)$/.exec(hash);
  const id = open ? decodeURIComponent(open[1]) : undefined;
  return (
    <SessionContext.Provider value={session}>
      <AppShell
        brand="Documents"
        sidebar={<SidebarNav label="Main" items={[{ href: "#/", label: "Documents", current: id === undefined }]} />}
        topbar={
          <>
            <ThemePick />
            <span className="muted">{session.me.name}{session.me.role === "viewer" ? " (viewer)" : ""}</span>
            <Button variant="secondary" size="sm" onClick={session.signOut}>Sign out</Button>
          </>
        }
      >
        {id === undefined ? <DocumentList go={go} /> : <EditorView key={id} id={id} go={go} />}
      </AppShell>
    </SessionContext.Provider>
  );
}

function App() {
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
  const session = useMemo<Session | null>(() => (auth && auth !== "checking" ? { api: clientFor(auth.token), token: auth.token, me: auth.me, signOut } : null), [auth, signOut]);
  if (auth === "checking") return <p role="status" className="signin muted">Checking your token…</p>;
  if (!session) return <>{problem && <p role="alert" className="signin form-error">{problem}</p>}<SignIn onSignedIn={(token, me) => (saveToken(token), setAuth({ token, me }))} /></>;
  return <Signed session={session} />;
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
