import * as Y from "yjs";
import { MAX_FOLDER_DEPTH, type Blobs, type Doc, type Json, type Store } from "agentic-identity";
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
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const bad = (): never => { throw new Error("account data is damaged; repair storage before retrying"); };
async function rows(store: Pick<Store, "query">, collection: string) {
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
  let catalog = await rows(deps.store, "documents");
  let resources = await rows(deps.store, "resources");
  const extra = await deps.documentIds?.() ?? [];
  if (deps.saveRoom) {
    const ids = new Set([...catalog.map(r => r.id), ...resources.filter(r => r.data.type === "docs").map(r => r.id), ...extra]);
    for (const id of ids) { if (!ID.test(id)) bad(); await deps.saveRoom(id); }
    catalog = await rows(deps.store, "documents");
    resources = await rows(deps.store, "resources");
  }
  const grants = await rows(deps.store, "grants");
  const invites = await rows(deps.store, "invites");
  const byResource = new Map(resources.map(r => [r.id, r.data]));
  const documentIds = new Set([...catalog.map(r => r.id), ...resources.filter(r => r.data.type === "docs").map(r => r.id), ...extra]);
  const ids = new Set(documentIds);
  // Empty folders with this subject's grant also belong in the account operation.
  for (const r of resources) if (r.data.type === "folder" && grants.some(g =>
    (g.data.resourceId === r.id && g.data.subjectKind === subject.kind && g.data.subjectId === subject.id) ||
    g.id === `${r.id}:${subject.kind}:${subject.id}` || g.id === `${r.id}:${subject.id}`)) ids.add(r.id);
  const pathIds = new Set(ids);
  for (const id of [...ids]) {
    const visited = new Set<string>();
    for (let current: string | undefined = id; current !== undefined;) {
      if (visited.has(current) || visited.size >= MAX_FOLDER_DEPTH) bad();
      visited.add(current); pathIds.add(current);
      const r = byResource.get(current);
      if (!r) { if (current !== id) bad(); break; }
      if (r.type === "folder") ids.add(current);
      if (r.parentId !== undefined && r.parentId !== null && (typeof r.parentId !== "string" || !r.parentId)) bad();
      current = r.parentId as string | undefined ?? undefined;
    }
  }
  for (const g of grants) {
    // Check both the key and the field: a damaged co-owner must not disappear.
    if (!pathIds.has(g.id.split(":")[0]) && !pathIds.has(g.data.resourceId as string)) continue;
    const d = g.data;
    if (typeof d.resourceId !== "string" || !RESOURCE_ID.test(d.resourceId) || !["human", "agent"].includes(d.subjectKind as string) || typeof d.subjectId !== "string" || !RESOURCE_ID.test(d.subjectId) || !["owner", "editor", "commenter", "viewer"].includes(d.role as string) || (g.id !== `${d.resourceId}:${d.subjectKind}:${d.subjectId}` && g.id !== `${d.resourceId}:${d.subjectId}`)) bad();
  }
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
        if (["createdAt", "updatedAt", "resolvedAt", "decidedAt"].includes(key) || (key === "at" && ("op" in obj || "body" in obj))) {
          const numeric = key === "updatedAt" || (key === "createdAt" && "createdBy" in obj);
          if (numeric ? typeof v !== "number" || !Number.isFinite(v) : typeof v !== "string" || !Number.isFinite(Date.parse(v))) bad();
        }
        if (["author", "createdBy", "updatedBy", "decidedBy", "resolvedBy", "by"].includes(key)) {
          if (mine(v) && collect) {
            // Export only fields supplied by this author, never a containing thread.
            const fields = key === "author" ? ["id", "op", "at", "body", "target", "replacement", "createdAt"]
              : key === "createdBy" ? ["title", "createdAt"]
              : key === "updatedBy" ? ["updatedAt"]
              : key === "resolvedBy" ? ["id", "resolvedAt"] : ["id", "status", "decidedAt", "at"];
            const record = Object.fromEntries(fields.filter(f => f in obj).map(f => [f, obj[f]]));
            authored.push(plain({ documentId: id, field: key, record: { ...record, [key]: v } }));
          }
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
    const resource = byResource.get(id);
    if (resource && (typeof resource.type !== "string" || !/^[a-z][a-z0-9_-]*$/.test(resource.type))) bad();
    const isDocument = !resource || resource.type === "docs";
    if (!(isDocument ? ID : RESOURCE_ID).test(id) || (!isDocument && documentIds.has(id))) bad();
    const ownGrants = grants.filter(g => g.data.resourceId === id);
    const madeInvites = invites.filter(i => i.data.resourceId === id && i.data.createdBy === subject.id);
    const held = ownGrants.filter(g => g.data.subjectKind === subject.kind && g.data.subjectId === subject.id);
    let owned = held.some(g => g.data.role === "owner");
    let otherOwner = false;
    let hasOwner = false;
    let current: string | undefined = id;
    const visited = new Set<string>();
    while (current !== undefined) {
      if (visited.has(current) || visited.size >= MAX_FOLDER_DEPTH) bad();
      visited.add(current);
      const r = byResource.get(current);
      if (!r) { if (current !== id) bad(); break; }
      const owners = grants.filter(g => g.data.resourceId === current && g.data.role === "owner");
      if (owners.length) hasOwner = true;
      for (const o of owners) {
        if (o.data.subjectKind !== subject.kind || o.data.subjectId !== subject.id) otherOwner = true;
        else owned = true;
      }
      if (r.parentId !== undefined && r.parentId !== null && (typeof r.parentId !== "string" || !r.parentId)) bad();
      current = r.parentId as string | undefined ?? undefined;
    }
    if (resource && !hasOwner) bad();
    let sole = owned && !otherOwner;
    const info = catalog.find(c => c.id === id)?.data;
    if (info) {
      if (!Number.isFinite(info.createdAt) || !info.createdBy || (info.updatedAt !== undefined && !Number.isFinite(info.updatedAt))) bad();
      checkAuthor(info.createdBy as never);
      if (!resource && RESOURCE_ID.test(subject.id) && ["human", "agent"].includes((info.createdBy as { kind: string }).kind) && mine(info.createdBy)) { owned = true; sole = true; }
    }
    const blob = isDocument ? await deps.blobs.get(`${id}.ydoc`) : null;
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
            else { const next = scrub({ [key]: old }, id, false) as Record<string, unknown>; if (JSON.stringify(old) !== JSON.stringify(next[key])) { v.set(key, next[key]); changed = true; } }
          }
        } else if (v instanceof Y.Array) {
          for (let i = v.length - 1; i >= 0; i--) {
            const old = v.get(i);
            if (old instanceof Y.AbstractType) visit(old);
            else { const next = scrub(old, id, false); if (JSON.stringify(old) !== JSON.stringify(next)) { v.delete(i, 1); v.insert(i, [next]); changed = true; } }
          }
        }
      };
      const roots = [doc.ydoc.getArray("edits"), ...["threads", "suggestions", "applied"].map(name => doc!.ydoc.getMap(name))];
      for (const root of roots) { scrub(root.toJSON(), id, !owned); visit(root); }
    }
    entries.push({ isDocument, depth: visited.size, madeInvites, id, info, cleanedInfo, blob, doc, changed, owned, sole, held, resource, authored: authored.length - before });
  }
  entries.sort((a, b) => b.depth - a.depth);
  return { entries, authored, resources };
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
      documents: entries.filter(e => e.owned && e.isDocument).map(e => plain({ id: e.id, ...(e.info ?? {}), markdown: e.blob ? AgenticDoc.fromUpdate(e.blob.data).toMarkdown() : null })),
      blobs: entries.filter(e => e.owned && e.blob).map(e => ({ documentId: e.id, encoding: "base64", data: toBase64(e.blob!.data) })),
      grants: entries.flatMap(e => e.held.map(g => plain({ id: g.id, ...g.data }))),
      sharing, authored,
    };
  },
  async eraseAccount(subject, deps) {
    const { entries, resources } = await plan(subject, deps);
    // A sole folder can go only if every child also goes. Check before writes.
    const soleIds = new Set(entries.filter(e => e.sole).map(e => e.id));
    for (const e of entries) if (e.sole && resources.some(r => r.data.parentId === e.id && !soleIds.has(r.id))) bad();

    const counts = { documents: 0, blobs: 0, grants: 0, sharing: 0, authored: 0 };
    for (const e of entries) {
      if (e.sole) {
        if (e.isDocument) await deps.eraseRoom?.(e.id);
        if (e.blob) { await deps.blobs.delete(`${e.id}.ydoc`); counts.blobs++; }
        // Keep the owner record until the blob and catalog go, so a retry finds it.
        if (e.isDocument) await deps.store.delete("documents", e.id);
        if (e.resource) {
          let removed = 1;
          for (const collection of ["grants", "invites", "links"]) removed += (await rows(deps.store, collection)).filter(r => r.data.resourceId === e.id).length;
          // The host authorizes account erasure. Ownership was checked in the plan,
          // including inherited owners and supported legacy grant keys.
          for (const collection of ["invites", "links", "audit"]) {
            for (const r of await rows(deps.store, collection)) if (r.data.resourceId === e.id) await deps.store.delete(collection, r.id);
          }
          await deps.store.transaction(async tx => {
            for (const g of await rows(tx, "grants")) if (g.data.resourceId === e.id) await tx.delete("grants", g.id);
            await tx.delete("resources", e.id);
          });
          counts.sharing += removed;
        }
        if (e.isDocument) counts.documents++;
        counts.grants += e.held.length;
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
