// Failure cases: sole vs shared ownership; authored records and machine labels;
// damaged owners or blobs; interruption after blob deletion; repeat counts zero;
// uncataloged blobs supplied by the host; authors removed from encoded history.
import { createMemoryBlobs, createMemoryStore } from "agentic-identity";
import { expect, test } from "vitest";
import { AgenticDoc } from "./doc.js";
import { fromBase64 } from "./package.js";
import { DocsService } from "./service.js";
import { documentsAccount } from "./account.js";
import { Threads, Suggestions } from "./review.js";
const subject = { kind: "human", id: "account-subject-ada" } as const;
const ada = { kind: "human", name: "account-subject-ada" } as const;
const bob = { kind: "human", name: "bob" } as const;
const ctx = { principalId: "account-subject-ada", kind: "human", chain: [{ kind: "human", id: "account-subject-ada" }], scopes: ["docs:admin"] } as const;
async function setup() {
  const deps = { store: createMemoryStore(), blobs: createMemoryBlobs() };
  const service = new DocsService(deps);
  await service.create("mine", "# Mine", ada);
  await service.create("shared", "# Shared", ada);
  await service.sharing.grant(ctx as never, "shared", { kind: "human", id: "bob" }, "owner");
  await service.sharing.invite(ctx as never, "shared", { role: "viewer", email: "kit@example.com" });
  await service.write("shared", d => {
    new Threads(d).add({ text: "Shared" }, "private comment", ada);
    new Suggestions(d).add({ text: "Shared" }, "proposal", ada);
  });
  return { deps, service };
}
test("exports full blobs and history, deletes sole ownership, preserves shared owners, retries", async () => {
  const { deps, service } = await setup();
  const out = await documentsAccount.exportAccount(subject, deps);
  expect(out.documents).toHaveLength(2);
  expect(out.blobs).toHaveLength(2);
  const saved = out.blobs.find(b => (b as { documentId: string }).documentId === "shared") as { data: string };
  expect(new Threads(AgenticDoc.fromUpdate(fromBase64(saved.data))).list()[0].messages[0].body).toBe("private comment");
  const counts = await documentsAccount.eraseAccount(subject, deps);
  expect(counts.documents).toBe(1);
  expect(await deps.blobs.get("mine.ydoc")).toBeNull();
  expect(await deps.store.get("grants", "shared:human:bob")).not.toBeNull();
  expect((await deps.store.query("invites")).items).toHaveLength(0);
  const bytes = (await deps.blobs.get("shared.ydoc"))!.data;
  expect(new TextDecoder().decode(bytes)).not.toContain('account-subject-ada');
  expect(await service.read("shared", d => d.toMarkdown())).toContain("Shared");
  expect(Object.values(await documentsAccount.eraseAccount(subject, deps)).every(n => n === 0)).toBe(true);
});
test("delegated agent authors stay machine labeled and are scrubbed separately", async () => {
  const { deps, service } = await setup();
  await service.write("shared", d => d.append("Bot text", { kind: "agent_of_human", name: "scribe" }));
  const who = { kind: "agent_of_human", id: "scribe" } as const;
  expect((await documentsAccount.exportAccount(who, deps)).authored.length).toBeGreaterThan(0);
  await documentsAccount.eraseAccount(who, deps);
  expect(await service.read("shared", d => d.edits().at(-1)!.author)).toEqual({ kind: "agent_of_human", name: "(erased)" });
});
test("damaged owners and unreadable blobs fail before any delete", async () => {
  for (const damage of ["owner", "blob"]) {
    const { deps } = await setup();
    if (damage === "owner") await deps.store.put("grants", "shared:human:bob", { resourceId: "shared", role: "owner", subjectId: "bob" });
    else await deps.blobs.put("shared.ydoc", new Uint8Array([0xff]));
    await expect(documentsAccount.eraseAccount(subject, deps)).rejects.toThrow();
    expect(await deps.blobs.get("mine.ydoc")).not.toBeNull();
  }
});
test("a retry finishes after the blob delete fails", async () => {
  const { deps } = await setup();
  const original = deps.blobs.delete.bind(deps.blobs);
  let fail = true;
  deps.blobs.delete = async key => { await original(key); if (fail) { fail = false; throw new Error("interrupted"); } };
  await expect(documentsAccount.eraseAccount(subject, deps)).rejects.toThrow("interrupted");
  await documentsAccount.eraseAccount(subject, deps);
  expect(await deps.store.get("resources", "mine")).toBeNull();
});

test("host inventory finds uncataloged authored blobs and bad subjects fail", async () => {
  const { deps } = await setup();
  await deps.blobs.put("legacy.ydoc", AgenticDoc.fromMarkdown("Legacy", ada).encode());
  const all = { ...deps, documentIds: async () => ["legacy"] };
  expect((await documentsAccount.exportAccount(subject, all)).authored.length).toBeGreaterThan(0);
  await documentsAccount.eraseAccount(subject, all);
  expect(new TextDecoder().decode((await deps.blobs.get("legacy.ydoc"))!.data)).not.toContain("account-subject-ada");
  for (const kind of [undefined, "unknown"]) await expect(documentsAccount.exportAccount({ id: "account-subject-ada", kind } as never, deps)).rejects.toThrow("subject");
});

test("an independent agent owns data and a person with the same id does not", async () => {
  const deps = { store: createMemoryStore(), blobs: createMemoryBlobs() };
  await new DocsService(deps).create("agent-doc", "Agent data", { kind: "agent", name: "account-subject-ada", scopes: ["docs:admin"] });
  expect((await documentsAccount.exportAccount(subject, deps)).documents).toHaveLength(0);
  const agent = { id: "account-subject-ada", kind: "agent" } as const;
  expect((await documentsAccount.exportAccount(agent, deps)).documents).toHaveLength(1);
  await documentsAccount.eraseAccount(agent, deps);
  expect(await deps.blobs.get("agent-doc.ydoc")).toBeNull();
});

test("an inherited co-owner prevents deletion", async () => {
  const { deps } = await setup();
  await deps.store.put("resources", "folder", { id: "folder", type: "folder" });
  await deps.store.put("grants", "folder:human:bob", { resourceId: "folder", subjectKind: "human", subjectId: "bob", role: "owner" });
  const resource = (await deps.store.get("resources", "mine"))!;
  await deps.store.put("resources", "mine", { ...resource, parentId: "folder" });
  await documentsAccount.eraseAccount(subject, deps);
  expect(await deps.blobs.get("mine.ydoc")).not.toBeNull();
  expect(await deps.store.get("grants", "mine:human:account-subject-ada")).toBeNull();
  expect(await deps.store.get("grants", "folder:human:bob")).not.toBeNull();
});

test("damaged catalog times and grant roles stop both account calls", async () => {
  for (const damage of ["time", "role"]) {
    const { deps } = await setup();
    if (damage === "time") await deps.store.put("documents", "shared", { ...(await deps.store.get("documents", "shared"))!, createdAt: "yesterday" });
    else await deps.store.put("grants", "shared:human:bob", { resourceId: "shared", subjectKind: "human", subjectId: "bob", role: "invalid" });
    for (const run of [documentsAccount.exportAccount, documentsAccount.eraseAccount]) await expect(run(subject, deps)).rejects.toThrow();
    expect(await deps.blobs.get("mine.ydoc")).not.toBeNull();
  }
});

test("scrubs resolvers and acceptance records while preserving other authors", async () => {
  const { deps, service } = await setup();
  await service.write("shared", d => {
    const threads = new Threads(d);
    threads.resolve(threads.list()[0].id, ada);
    const suggestions = new Suggestions(d);
    const id = suggestions.add({ text: "Shared" }, "Changed", bob);
    suggestions.accept(id, ada);
  });
  await documentsAccount.eraseAccount(subject, deps);
  await service.read("shared", d => {
    expect(new Threads(d).list()[0].resolvedBy).toEqual({ kind: "human", name: "(erased)" });
    const accepted = new Suggestions(d).list().find(s => s.status === "accepted")!;
    expect(accepted.author).toEqual(bob);
    expect(accepted.decidedBy).toEqual({ kind: "human", name: "(erased)" });
  });
  expect(new TextDecoder().decode((await deps.blobs.get("shared.ydoc"))!.data)).not.toContain("account-subject-ada");
});

test("a failed catalog delete keeps ownership for retry even with another creator", async () => {
  const { deps } = await setup();
  await deps.store.put("documents", "mine", { ...(await deps.store.get("documents", "mine"))!, createdBy: bob });
  const original = deps.store.delete.bind(deps.store);
  let fail = true;
  deps.store.delete = async (collection, id) => {
    if (collection === "documents" && id === "mine" && fail) { fail = false; throw new Error("catalog interrupted"); }
    await original(collection, id);
  };
  await expect(documentsAccount.eraseAccount(subject, deps)).rejects.toThrow("catalog interrupted");
  expect(await deps.store.get("resources", "mine")).not.toBeNull();
  await documentsAccount.eraseAccount(subject, deps);
  expect(await deps.store.get("documents", "mine")).toBeNull();
  expect(await deps.store.get("resources", "mine")).toBeNull();
});

test("a damaged history timestamp fails before any data is deleted", async () => {
  const { deps, service } = await setup();
  await service.write("shared", d => {
    const log = d.ydoc.getArray("edits");
    const entry = log.get(0) as Record<string, unknown>;
    log.delete(0, 1); log.insert(0, [{ ...entry, at: "invalid time" }]);
  });
  await expect(documentsAccount.eraseAccount(subject, deps)).rejects.toThrow();
  expect(await deps.blobs.get("mine.ydoc")).not.toBeNull();
});
