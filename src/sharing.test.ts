// Documents hold no roles of their own. A host that shares a document through agentic-identity keys each
// grant on the principal kind and the id, and erases the grants with the document. These tests pin both,
// against the same Store a DocsService uses.
import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext } from "agentic-identity";
import { describe, expect, it } from "vitest";
import { DocsService } from "./service.js";

const ctx = (id: string, kind: "human" | "agent"): PrincipalContext => ({ principalId: id, kind, chain: [{ id, kind }], scopes: ["docs:admin"] });

describe("sharing with agentic-identity 0.4", () => {
  it("gives a person and an agent with the same id separate roles", async () => {
    const store = createMemoryStore();
    const sharing = createSharing(store);
    const owner = ctx("ana", "human");
    await sharing.createResource(owner, { id: "plan", type: "docs" });
    await sharing.grant(owner, "plan", { kind: "human", id: "kit" }, "editor");

    expect((await sharing.can(ctx("kit", "human"), "write", "plan")).role).toBe("editor");
    expect((await sharing.can(ctx("kit", "agent"), "read", "plan")).allowed).toBe(false);

    await sharing.grant(owner, "plan", { kind: "agent", id: "kit" }, "viewer");
    expect((await sharing.can(ctx("kit", "agent"), "read", "plan")).role).toBe("viewer");
    expect((await sharing.can(ctx("kit", "agent"), "write", "plan")).allowed).toBe(false);
    expect((await sharing.can(ctx("kit", "human"), "write", "plan")).role).toBe("editor");

    await sharing.revokeGrant(owner, "plan", { kind: "agent", id: "kit" });
    expect((await sharing.can(ctx("kit", "agent"), "read", "plan")).allowed).toBe(false);
    expect((await sharing.can(ctx("kit", "human"), "write", "plan")).allowed).toBe(true);
  });

  it("erases the grants with the resource, so a new document with the same id starts clean", async () => {
    const store = createMemoryStore();
    const sharing = createSharing(store);
    const docs = new DocsService({ blobs: createMemoryBlobs(), store });
    const owner = ctx("ana", "human");
    await docs.create("plan", "# Plan\n", { kind: "human", name: "ana" }, owner); // a new document registers its owner
    await sharing.grant(owner, "plan", { kind: "human", id: "kit" }, "editor");
    await sharing.grant(owner, "plan", { kind: "agent", id: "kit" }, "viewer");
    expect((await sharing.listGrants(owner, "plan")).grants).toHaveLength(3);

    await sharing.deleteResource(owner, "plan");

    expect((await sharing.can(ctx("kit", "human"), "read", "plan")).allowed).toBe(false);
    expect((await sharing.can(ctx("kit", "agent"), "read", "plan")).allowed).toBe(false);
    // The erase touches sharing data only. The document and its catalog entry stay.
    await expect(docs.read("plan", (d) => d.toMarkdown())).resolves.toContain("Plan");
    await sharing.createResource(ctx("bo", "human"), { id: "plan", type: "docs" });
    const grants = (await sharing.listGrants(ctx("bo", "human"), "plan")).grants;
    expect(grants.map((g) => `${g.subjectKind}:${g.subjectId}:${g.role}`)).toEqual(["human:bo:owner"]);
  });
});
