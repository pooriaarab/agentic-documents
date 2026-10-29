import { useCallback, useEffect, useState, type FormEvent } from "react";
import { parseInvitee } from "agentic-design";
import { Button, Dialog, IconButton, CloseIcon, Input, PresenceChip, Select, Switch, type DialogProps, type PresenceEntry } from "agentic-design/react";
import type { Grant, ShareRole, Subject } from "../src/client.js";
import { describe, isMachine, useSession } from "./api.js";

const ROLES: ShareRole[] = ["viewer", "commenter", "editor", "owner"];
const INVITE_ROLES = ROLES.filter((r) => r !== "owner") as Exclude<ShareRole, "owner">[];
const DAY = 86_400_000;
const EXPIRY = { never: undefined, "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY } as const;
type Expiry = keyof typeof EXPIRY;

const NOT_ENFORCED = "Roles are saved, but reads and writes do not check them yet. A change here does not stop a token that has its own role.";
const HANDLE = /^[a-z][a-z0-9_-]{1,31}$/; // the rule of the server

const entryOf = (g: Grant): PresenceEntry => ({ id: `${g.subjectKind}:${g.subjectId}`, name: g.subjectId, kind: g.subjectKind === "agent" ? "agent" : "person" });

/** Who may open this document and as what, and the link to share it. Only an owner sees the controls. The server refuses everyone else. */
export function ShareDocument({ id, open, onOpenChange }: Pick<DialogProps, "open" | "onOpenChange"> & { id: string }) {
  const { api, baseUrl } = useSession();
  const [contributors, setContributors] = useState<PresenceEntry[]>();
  const [grants, setGrants] = useState<Grant[]>();
  const [refused, setRefused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("");
  const [who, setWho] = useState("");
  const [inviteRole, setInviteRole] = useState<Exclude<ShareRole, "owner">>("viewer");
  const [linkRole, setLinkRole] = useState<Exclude<ShareRole, "owner">>("viewer");
  const [expiry, setExpiry] = useState<Expiry>("7d");
  const [signedInOnly, setSignedInOnly] = useState(true);
  const [link, setLink] = useState<{ id: string; token: string }>();
  const [busy, setBusy] = useState(false);
  const address = `${baseUrl.replace(/\/+$/, "")}/#/d/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    try {
      setGrants(await api.grants(id));
      setRefused(false);
      setFailed(false);
    } catch (e) {
      setGrants([]);
      // Only the server's refusal means "not an owner". Any other failure says what it was.
      const forbidden = (e as { code?: string }).code === "FORBIDDEN";
      setRefused(forbidden);
      setFailed(!forbidden);
      if (!forbidden) setError(describe(e));
    }
  }, [api, id]);

  useEffect(() => {
    if (!open) return;
    (setStatus(""), setError(undefined), setLink(undefined), setWho(""));
    api.room(id).then(({ contributors: list }) => setContributors(list.map((c) => ({ id: `${c.kind}:${c.name}`, name: c.name, kind: isMachine(c.kind) ? "agent" : "person" }))), () => setContributors([]));
    void load();
  }, [open, api, id, load]);

  /** Runs one change, shows the server's refusal, and reads the grants again. */
  async function act(done: string, run: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      await run();
      setStatus(done);
      await load();
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }

  function invite(event: FormEvent) {
    event.preventDefault();
    const target = parseInvitee(who);
    const handle = target?.kind === "agent" ? target.to.replace(/^@/, "").toLowerCase() : undefined;
    if (!target || (handle !== undefined && !HANDLE.test(handle))) return setError("Type an email address for a person, or @handle for an agent: a letter, then letters, digits, - or _.");
    void act(`Invite made for ${who.trim()}.`, async () => {
      await api.invite(id, { role: inviteRole, ...(handle === undefined ? { email: target.to } : { handle }) });
      setWho("");
    });
  }

  const makeLink = () =>
    act("Link made. Copy the token now: it shows once.", async () => {
      if (link) await api.unlink(id, { link: link.id }); // one link at a time
      setLink(undefined);
      const expiresIn = EXPIRY[expiry];
      setLink(await api.link(id, { role: linkRole, signedInOnly, ...(expiresIn ? { expiresAt: Date.now() + expiresIn } : {}) }));
    });

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => setStatus("Copied."), () => setStatus("Could not copy."));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Share document" description="Anyone with an access token for this server can open the address.">
      <div className="form">
        <Input label="Address" readOnly value={address} onFocus={(e) => e.currentTarget.select()} />
        <div className="form-actions">
          <Button type="button" onClick={() => void copy(address)}>Copy address</Button>
        </div>

        <h3 className="section-title">People and agents with access</h3>
        {!refused && !failed && <p className="muted">{NOT_ENFORCED}</p>}
        {grants === undefined ? (
          <p role="status">Loading…</p>
        ) : refused ? (
          <p>Only an owner can see or change who has access.</p>
        ) : failed ? null : (
          <ul className="people">
            {grants.map((g) => {
              const subject: Subject = `${g.subjectKind}:${g.subjectId}`;
              return (
                <li key={subject} className="share-row">
                  <PresenceChip entry={entryOf(g)} />
                  <Select label={`Role for ${g.subjectId}`} hideLabel value={g.role} disabled={busy} onChange={(e) => void act(`${g.subjectId} is now ${e.target.value}.`, () => api.grant(id, { to: subject, role: e.target.value as ShareRole }))}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </Select>
                  <IconButton label={`Remove ${g.subjectId}`} icon={<CloseIcon />} disabled={busy} onClick={() => void act(`Removed ${g.subjectId}.`, () => api.revoke(id, { to: subject }))} />
                </li>
              );
            })}
          </ul>
        )}

        {!refused && !failed && grants !== undefined && (
          <>
            <form onSubmit={invite} className="form" aria-label="Invite">
              <Input label="Invite by email or @handle" value={who} onChange={(e) => setWho(e.target.value)} autoComplete="off" hint="An email invites a person. @handle invites an agent." />
              <Select label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
                {INVITE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
              <div className="form-actions"><Button type="submit" loading={busy}>Invite</Button></div>
            </form>

            <h3 className="section-title">Share link</h3>
            <Select label="Link role" value={linkRole} onChange={(e) => setLinkRole(e.target.value as typeof linkRole)}>
              {INVITE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
            <Select label="Link ends" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
              <option value="never">Never</option>
              <option value="1d">In 1 day</option>
              <option value="7d">In 7 days</option>
              <option value="30d">In 30 days</option>
            </Select>
            <Switch label="Signed-in visitors only" checked={signedInOnly} onChange={(e) => setSignedInOnly(e.target.checked)} />
            <div className="form-actions">
              {link && <Button type="button" variant="secondary" disabled={busy} onClick={() => void act("Link revoked.", async () => (await api.unlink(id, { link: link.id }), setLink(undefined)))}>Revoke link</Button>}
              <Button type="button" disabled={busy} onClick={() => void makeLink()}>{link ? "Make a new link" : "Make a link"}</Button>
            </div>
            {link && (
              <>
                <Input label="Link id" readOnly value={link.id} hint="Keep it. You need it to revoke the link from the CLI or the API." onFocus={(e) => e.currentTarget.select()} />
                <Input label="Link token (shows once)" readOnly value={link.token} onFocus={(e) => e.currentTarget.select()} />
                <div className="form-actions"><Button type="button" onClick={() => void copy(link.token)}>Copy token</Button></div>
              </>
            )}
          </>
        )}

        {error && <p role="alert" className="form-error">{error}</p>}
        <span role="status">{status}</span>

        <h3 className="section-title">Who has changed this document</h3>
        {contributors === undefined ? <p role="status">Loading…</p> : contributors.length === 0 ? <p>Nobody has edited it in a live room yet.</p> : <ul className="people">{contributors.map((p) => <li key={p.id}><PresenceChip entry={p} /></li>)}</ul>}
      </div>
    </Dialog>
  );
}
