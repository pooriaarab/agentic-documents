import * as Y from "yjs";
import { MAX_FOLDER_DEPTH, createSharing, type Blobs, type Doc, type Json, type PrincipalContext, type Store } from "agentic-identity";
import { AgenticDoc, checkAuthor, PRINCIPAL_KINDS, type PrincipalKind } from "./doc.js";
import { toBase64 } from "./package.js";
import { DocsService } from "./service.js";

export interface DocumentsAccountSubject { id: string; kind: PrincipalKind }
export interface DocumentsAccountDeps {
  store: Store;
  blobs: Blobs;
  /** Include legacy blobs with no catalog or sharing record. The Blobs port has no list call. */
  documentIds?: () => Promise<string[]>;
  /** Flush rooms before reading. Stop writes for the whole export/erase operation. */
  saveRoom?: (id: string) => Promise<void>;
  /** Clear rooms before an erase. Required by the host when live rooms run. */
  eraseRoom?: (id: string) => Promise<void>;
}
export type DocumentsCollection = "documents" | "blobs" | "grants" | "sharing" | "authored";
/** Structurally matches AccountPackage<DocumentsAccountDeps> in the identity account registry. */
export interface DocumentsAccount {
  id: "documents";
  exportAccount(subject: DocumentsAccountSubject, deps: DocumentsAccountDeps): Promise<Record<DocumentsCollection, Json[]>>;
  eraseAccount(subject: DocumentsAccountSubject, deps: DocumentsAccountDeps): Promise<Record<DocumentsCollection, number>>;
}
const ERASED = "(erased)";
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const bad = (): never => { throw new Error("account data is damaged; repair storage before retrying"); };
async function rows(store: Store, collection: string) {
  const result: { id: string; data: Doc }[] = [];
  const seen = new Set<string>();
  for (let cursor: string | undefined; ;) {
    const page = await store.query(collection, { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    result.push(...page.items);
    if (page.nextCursor === undefined) return result;
    if (seen.has(page.nextCursor)) bad();
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Read and validate the complete plan before making any change. */
async function plan(subject: DocumentsAccountSubject, deps: DocumentsAccountDeps) {
  if (!subject || typeof subject.id !== "string" || !subject.id.trim() || subject.id === ERASED || !PRINCIPAL_KINDS.includes(subject.kind)) throw new Error("subject needs an id and a known kind");
  if (!deps?.store || !deps.blobs) throw new Error("documentsAccount needs store and blobs");
  const catalog = await rows(deps.store, "documents");
  const resources = await rows(deps.store, "resources");
  const grants = await rows(deps.store, "grants");
  const invites = await rows(deps.store, "invites");
  const byResource = new Map(resources.map(r => [r.id, r.data]));
  const ids = new Set([...catalog.map(r => r.id), ...resources.filter(r => r.data.type === "docs").map(r => r.id), ...await deps.documentIds?.() ?? []]);
  const mine = (v: unknown): boolean => {
    const p = checkAuthor(v as never);
    return p.kind === subject.kind && p.name === subject.id;
  };
  // Author fields occur in catalog, edits, suggestion decisions, thread messages, and applied decisions.
  const authored: Json[] = [];
  const scrub = (value: unknown, id: string, collect: boolean): unknown => {
    if (Array.isArray(value)) return value.map(v => scrub(v, id, collect));
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if ("kind" in obj && "name" in obj) {
        if (mine(obj)) return { ...obj, name: ERASED };
        return obj;
      }
      const copy: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(obj)) {
        if (["author", "createdBy", "updatedBy", "decidedBy", "resolvedBy", "by"].includes(key)) {
          if (mine(v) && collect) authored.push(plain({ documentId: id, field: key, record: obj }));
        }
        copy[key] = scrub(v, id, collect);
      }
      return copy;
    }
    if (typeof value === "number" && !Number.isFinite(value)) bad();
    return value;
  };
  const entries = [];
  for (const id of ids) {
    if (!ID.test(id)) bad();
    const resource = byResource.get(id);
    if (resource && resource.type !== "docs") bad();
    const ownGrants = grants.filter(g => g.data.resourceId === id);
    for (const g of ownGrants) {
      const d = g.data;
      if (!["human", "agent"].includes(d.subjectKind as string) || typeof d.subjectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(d.subjectId) || !["owner", "editor", "commenter", "viewer"].includes(d.role as string) || g.id !== `${id}:${d.subjectKind}:${d.subjectId}`) bad();
    }
    const madeInvites = invites.filter(i => i.data.resourceId === id && i.data.createdBy === subject.id);
    const held = ownGrants.filter(g => g.data.subjectKind === subject.kind && g.data.subjectId === subject.id);
    let owned = held.some(g => g.data.role === "owner");
    let otherOwner = false;
    let current: string | undefined = id;
    const visited = new Set<string>();
    while (current !== undefined) {
      if (visited.has(current) || visited.size >= MAX_FOLDER_DEPTH) bad();
      visited.add(current);
      const r = byResource.get(current);
      if (!r) { if (current !== id) bad(); break; }
      const owners = grants.filter(g => g.data.resourceId === current && g.data.role === "owner");
      if (!owners.length) bad();
      for (const o of owners) {
        if (!["human", "agent"].includes(o.data.subjectKind as string) || typeof o.data.subjectId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(o.data.subjectId) || o.id !== `${current}:${o.data.subjectKind}:${o.data.subjectId}`) bad();
        if (o.data.subjectKind !== subject.kind || o.data.subjectId !== subject.id) otherOwner = true;
        else owned = true;
      }
      if (r.parentId !== undefined && r.parentId !== null && (typeof r.parentId !== "string" || !r.parentId)) bad();
      current = r.parentId as string | undefined ?? undefined;
    }
    let sole = owned && !otherOwner;
    const info = catalog.find(c => c.id === id)?.data;
    if (info) {
      if (!Number.isFinite(info.createdAt) || !info.createdBy || (info.updatedAt !== undefined && !Number.isFinite(info.updatedAt))) bad();
      mine(info.createdBy);
      if (!resource && mine(info.createdBy)) { owned = true; sole = true; }
    }
    if (sole && resources.some(r => r.data.parentId === id)) bad();
    await deps.saveRoom?.(id);
    const blob = await deps.blobs.get(`${id}.ydoc`);
    const before = authored.length;
    const cleanedInfo = info ? scrub(info, id, !owned) as Doc : undefined;
    let doc: AgenticDoc | undefined;
    let changed = JSON.stringify(cleanedInfo) !== JSON.stringify(info);
    if (blob) {
      doc = AgenticDoc.fromUpdate(blob.data);
      if (doc.ydoc.store.pendingStructs || doc.ydoc.store.pendingDs) bad();
      new DocsService(deps).checkedState(id, doc);
      for (const root of doc.ydoc.share.keys()) if (!["default", "edits", "threads", "suggestions", "applied", "__tiptap_position_migrations:root:default"].includes(root)) bad();
      const visit = (v: unknown): void => {
        if (v instanceof Y.Map) {
          for (const [key, old] of v) {
            if (old instanceof Y.AbstractType) visit(old);
            else { const next = scrub({ [key]: old }, id, !owned) as Record<string, unknown>; if (JSON.stringify(old) !== JSON.stringify(next[key])) { v.set(key, next[key]); changed = true; } }
          }
        } else if (v instanceof Y.Array) {
          for (let i = v.length - 1; i >= 0; i--) {
            const old = v.get(i);
            if (old instanceof Y.AbstractType) visit(old);
            else { const next = scrub(old, id, !owned); if (JSON.stringify(old) !== JSON.stringify(next)) { v.delete(i, 1); v.insert(i, [next]); changed = true; } }
          }
        }
      };
      visit(doc.ydoc.getArray("edits"));
      for (const name of ["threads", "suggestions", "applied"]) visit(doc.ydoc.getMap(name));
    }
    if (!owned && authored.length > before && blob) authored.push({ documentId: id, encoding: "base64", data: toBase64(blob.data) });
    entries.push({ madeInvites, id, info, cleanedInfo, blob, doc, changed, owned, sole, held, resource, authored: authored.length - before });
  }
  // A grant that cannot be attributed to an app may hide this subject's data.
  for (const g of grants) if (g.data.subjectId === subject.id && (!["human", "agent"].includes(g.data.subjectKind as string) || typeof g.data.resourceId !== "string" || (!byResource.has(g.data.resourceId) && !ids.has(g.data.resourceId)))) bad();
  return { entries, authored };
}

export const documentsAccount: DocumentsAccount = {
  id: "documents",
  async exportAccount(subject, deps) {
    const { entries, authored } = await plan(subject, deps);
    const owned = new Set(entries.filter(e => e.owned).map(e => e.id));
    const sharing: Json[] = [];
    for (const collection of ["resources", "grants", "invites", "links"]) {
      for (const row of await rows(deps.store, collection)) {
        if (owned.has(collection === "resources" ? row.id : row.data.resourceId as string) || (collection === "invites" && row.data.createdBy === subject.id && entries.some(e => e.id === row.data.resourceId))) sharing.push(plain({ collection, id: row.id, ...row.data }));
      }
    }
    return {
      documents: entries.filter(e => e.owned).map(e => plain({ id: e.id, ...(e.info ?? {}), markdown: e.blob ? AgenticDoc.fromUpdate(e.blob.data).toMarkdown() : null })),
      blobs: entries.filter(e => e.owned && e.blob).map(e => ({ documentId: e.id, encoding: "base64", data: toBase64(e.blob!.data) })),
      grants: entries.flatMap(e => e.held.map(g => plain({ id: g.id, ...g.data }))),
      sharing, authored,
    };
  },
  async eraseAccount(subject, deps) {
    const { entries } = await plan(subject, deps);
    const counts = { documents: 0, blobs: 0, grants: 0, sharing: 0, authored: 0 };
    const ctx: PrincipalContext = { principalId: subject.id, kind: subject.kind, chain: [{ kind: subject.kind, id: subject.id }], scopes: ["docs:admin"] };
    for (const e of entries) {
      if (e.sole) {
        await deps.eraseRoom?.(e.id);
        if (e.blob) { await deps.blobs.delete(`${e.id}.ydoc`); counts.blobs++; }
        // Keep ownership and catalog until the blob goes, so a retry can find it.
        if (e.resource) {
          let removed = 1;
          for (const collection of ["grants", "invites", "links"]) removed += (await rows(deps.store, collection)).filter(r => r.data.resourceId === e.id).length;
          await createSharing(deps.store).deleteResource(ctx, e.id);
          counts.sharing += removed;
        }
        await deps.store.delete("documents", e.id);
        counts.documents++; counts.grants += e.held.length;
      } else {
        if (e.changed) {
          await deps.eraseRoom?.(e.id);
          if (e.doc && e.blob && !await deps.blobs.put(`${e.id}.ydoc`, e.doc.encode(), { ifMatch: e.blob.version })) throw new Error("document changed during account erase; stop writes and retry");
          if (e.cleanedInfo) await deps.store.put("documents", e.id, e.cleanedInfo);
          counts.authored += e.authored || 1;
        }
        for (const invite of e.madeInvites) { await deps.store.delete("invites", invite.id); counts.sharing++; }
        for (const g of e.held) { await deps.store.delete("grants", g.id); counts.grants++; counts.sharing++; }
      }
    }
    return counts;
  },
};
