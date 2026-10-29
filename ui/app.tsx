// The signed-in app: the document list and the editor page, in the Worker's page and in `mount` of `agentic-documents/ui`.
import { AppShell, Button, Select, SidebarNav, useTheme, type ThemePreference } from "agentic-design/react";
import { SessionContext, type Session } from "./api.js";
import { DocumentList } from "./list.js";
import { EditorView } from "./view.js";

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

/** The list when `id` is empty, else the editor for that document. `go` takes a `#/` route. */
export function Workspace({ session, id, go }: { session: Session; id: string | undefined; go: (hash: string) => void }) {
  return (
    <SessionContext.Provider value={session}>
      <AppShell
        brand="Documents"
        sidebar={<SidebarNav label="Main" items={[{ href: "#/", label: "Documents", current: id === undefined }]} />}
        topbar={
          <>
            <ThemePick />
            <span className="muted">{session.me.name}{session.me.role === "viewer" ? " (viewer)" : ""}</span>
            {session.signOut && <Button variant="secondary" size="sm" onClick={session.signOut}>Sign out</Button>}
          </>
        }
      >
        {id === undefined ? <DocumentList go={go} /> : <EditorView key={id} id={id} go={go} />}
      </AppShell>
    </SessionContext.Provider>
  );
}
