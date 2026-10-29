import { createSharing, EraseRefusedError, StoreConflictError, type Grant, type InviteSummary, type PrincipalContext, type Role, type Store, type SubjectKind } from "agentic-identity";
import { DocError, PRINCIPAL_KINDS, type Principal } from "./doc.js";

/** The resource type of a document in agentic-identity. The scopes are `docs:write` and `docs:admin`. */
export const RESOURCE_TYPE = "docs";
/** Sharing needs this scope. A person holds it in a local run. An agent holds it only when it is granted. */
export const SHARE_SCOPE = "docs:admin";
const MAX_PAGES = 20;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const ROLES = ["viewer", "commenter", "editor", "owner"] as const;
export const INVITE_ROLES = ["viewer", "commenter", "editor"] as const;

export interface GrantInput {
  kind: SubjectKind;
  id: string;
}
export interface InviteInput {
  role: Exclude<Role, "owner">;
  email?: string;
  handle?: string;
  expiresInMs?: number;
}
export interface LinkInput {
  role: Exclude<Role, "owner">;
  expiresAt?: number;
  signedInOnly?: boolean;
}

/** What every surface can do to the sharing of one document. Each call needs an owner. */
export interface DocSharing {
  grants(ctx: PrincipalContext, id: string): Promise<Grant[]>;
  grant(ctx: PrincipalContext, id: string, to: GrantInput, role: Role): Promise<void>;
  revoke(ctx: PrincipalContext, id: string, to: GrantInput): Promise<void>;
  invites(ctx: PrincipalContext, id: string): Promise<InviteSummary[]>;
  invite(ctx: PrincipalContext, id: string, input: InviteInput): Promise<{ id: string }>;
  /** The token comes back once. The server keeps its hash only. */
  link(ctx: PrincipalContext, id: string, input: LinkInput): Promise<{ id: string; token: string }>;
  unlink(ctx: PrincipalContext, id: string, link: string): Promise<void>;
}

/** `kind:id` of a person or an agent that holds a role. */
export function parseSubject(text: string): GrantInput {
  const at = text.indexOf(":");
  const kind = text.slice(0, at);
  if (at < 1 || (kind !== "human" && kind !== "agent")) throw new DocError("INVALID_INPUT", `"${text}" is not human:<id> or agent:<id>`);
  return { kind, id: text.slice(at + 1) };
}

/**
 * The rights of an author who has no sign-in context: the CLI, the MCP server, and the development token table. A person
 * holds every docs scope. An agent holds the docs scopes it was given, and no more. The root of the chain is the author, so only a
 * `human` or an `agent` can own a document here.
 */
export function contextOf(author: Principal | undefined): PrincipalContext {
  if (!author || !PRINCIPAL_KINDS.includes(author.kind)) throw new DocError("INVALID_AUTHOR", "sharing needs an author: pass --as kind:name");
  // agentic-identity stores a grant under this name and refuses a name it cannot read back, so such an owner could never be changed.
  if (!SAFE_ID.test(author.name)) throw new DocError("INVALID_AUTHOR", "sharing needs an author name of 1 to 128 letters, digits, - and _");
  const scopes = author.kind === "human" ? [SHARE_SCOPE] : (author.scopes ?? []).filter((s) => /^[a-z*]+:(read|comment|write|admin)$/.test(s));
  return { principalId: author.name, kind: author.kind, chain: [{ kind: author.kind, id: author.name }], scopes: scopes as PrincipalContext["scopes"] };
}

/** `contextOf`, or a context with no scopes when the author's name cannot hold a grant. Such an author shares nothing. */
export function safeContextOf(author: Principal): PrincipalContext {
  try {
    return contextOf(author);
  } catch {
    return { principalId: author.name, kind: author.kind, chain: [{ kind: author.kind, id: author.name }], scopes: [] };
  }
}

/** The refusals of agentic-identity as the errors of this package. One message for "no owner" keeps a probe from learning more. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EraseRefusedError) throw new DocError("CONFLICT", `the sharing data cannot be erased: ${error.message}`);
    if (error instanceof StoreConflictError) throw new DocError("CONFLICT", "the sharing of this document kept changing; try again");
    if (error instanceof Error && error.message === "forbidden") throw new DocError("FORBIDDEN", "only an owner of this document may share it");
    if (error instanceof Error && /^(invalid |give an email|expiresAt |expiresInMs |the last owner|limit must)/.test(error.message)) throw new DocError("INVALID_INPUT", error.message);
    throw error;
  }
}

/** Sharing in a Store, with agentic-identity doing the grants, invites, and links. */
export class StoreSharing implements DocSharing {
  private readonly sharing;

  constructor(
    private readonly store: Store,
    private readonly known: { exists(id: string): Promise<boolean>; creator(id: string): Promise<Principal | undefined> },
  ) {
    this.sharing = createSharing(store);
  }

  /**
   * The author of a new document owns it. A resource that exists for a document that was just made is left over from an
   * older document with the same id, so it is erased first: the new document must never inherit its owners. When that
   * erase fails, this throws, and the caller must undo the new document. Registering the owner is best effort: an author
   * with no root person or agent, or with no `docs:write` scope, owns nothing, and the creator claims the document on
   * the first share call.
   */
  async register(ctx: PrincipalContext | undefined, id: string): Promise<void> {
    await this.erase(id);
    if (!ctx) return;
    try {
      await this.sharing.createResource(ctx, { id, type: RESOURCE_TYPE });
    } catch {
      /* no root person or agent, or no scope: nobody owns it, which fails closed */
    }
  }

  /**
   * Erase the sharing data of a document that is removed or made again. The caller has already passed the remove check,
   * so this does not ask for an owner: it acts as one owner that the store names. Nothing of the old document stays,
   * whoever removes it.
   */
  async erase(id: string): Promise<void> {
    const found = (await this.store.get("resources", id)) as { type?: unknown } | null;
    if (found === null) return;
    if (found.type !== RESOURCE_TYPE) throw new DocError("CONFLICT", `"${id}" is taken by another kind of resource in the sharing data`);
    const [owner] = (await this.store.query("grants", { where: { resourceId: id, role: "owner" }, limit: 1 })).items;
    const data = owner?.data as { subjectKind?: unknown; subjectId?: unknown } | undefined;
    if (data && (data.subjectKind === "human" || data.subjectKind === "agent") && typeof data.subjectId === "string") {
      const ctx: PrincipalContext = { principalId: data.subjectId, kind: data.subjectKind, chain: [{ kind: data.subjectKind, id: data.subjectId }], scopes: [SHARE_SCOPE] };
      await guard(() => this.sharing.deleteResource(ctx, id));
      return;
    }
    // A resource with no readable owner cannot be erased through agentic-identity. Fail closed: the document is not made or removed.
    throw new DocError("CONFLICT", `the sharing data of "${id}" has no owner and cannot be erased; ask an operator`);
  }

  /** A document made before sharing has no resource. Its creator becomes the owner. Anyone else is refused. */
  private async ready(ctx: PrincipalContext, id: string): Promise<void> {
    const found = (await this.store.get("resources", id)) as { type?: unknown } | null;
    if (found !== null) {
      // A resource of another kind with this id is not this document's. Fail closed.
      if (found.type !== RESOURCE_TYPE) throw new DocError("FORBIDDEN", "only an owner of this document may share it");
      return;
    }
    if (!(await this.known.exists(id))) throw new DocError("NO_DOCUMENT", `no document with id "${id}"`);
    const made = await this.known.creator(id);
    const root = ctx.chain[0];
    if (!made || !root || made.kind !== root.kind || made.name !== root.id) throw new DocError("FORBIDDEN", "only an owner of this document may share it");
    await guard(() => this.sharing.createResource(ctx, { id, type: RESOURCE_TYPE })).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "resource exists") throw error;
    });
  }

  private async owned<T>(ctx: PrincipalContext, id: string, run: () => Promise<T>): Promise<T> {
    await this.ready(ctx, id);
    return guard(run);
  }

  async grants(ctx: PrincipalContext, id: string): Promise<Grant[]> {
    return this.owned(ctx, id, async () => {
      const found: Grant[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { grants, nextCursor } = await this.sharing.listGrants(ctx, id, { limit: 200, cursor });
        found.push(...grants);
        if ((cursor = nextCursor) === undefined) return found;
      }
      throw new DocError("CONFLICT", `the document has more than ${MAX_PAGES * 200} grants; a partial list would mislead`);
    });
  }

  grant(ctx: PrincipalContext, id: string, to: GrantInput, role: Role): Promise<void> {
    return this.owned(ctx, id, () => this.sharing.grant(ctx, id, to, role));
  }

  revoke(ctx: PrincipalContext, id: string, to: GrantInput): Promise<void> {
    return this.owned(ctx, id, () => this.sharing.revokeGrant(ctx, id, to));
  }

  async invites(ctx: PrincipalContext, id: string): Promise<InviteSummary[]> {
    return this.owned(ctx, id, async () => {
      const found: InviteSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { invites, nextCursor } = await this.sharing.listInvites(ctx, id, { limit: 200, cursor });
        found.push(...invites);
        if ((cursor = nextCursor) === undefined) return found;
      }
      throw new DocError("CONFLICT", `the document has more than ${MAX_PAGES * 200} invites; a partial list would mislead`);
    });
  }

  invite(ctx: PrincipalContext, id: string, input: InviteInput): Promise<{ id: string }> {
    return this.owned(ctx, id, () => this.sharing.createInvite(ctx, id, input));
  }

  link(ctx: PrincipalContext, id: string, input: LinkInput): Promise<{ id: string; token: string }> {
    return this.owned(ctx, id, () => this.sharing.createLink(ctx, id, input));
  }

  async unlink(ctx: PrincipalContext, id: string, link: string): Promise<void> {
    await this.owned(ctx, id, async () => {
      const found = (await this.store.get("links", link)) as { resourceId?: unknown } | null;
      if (found?.resourceId !== id) throw new Error("forbidden"); // a link of another document is not this owner's to revoke here
      await this.sharing.revokeLink(ctx, link);
    });
  }
}
