import type { PrincipalContext } from "agentic-identity";
import { z } from "zod";
import { DocError, type Principal, type Target, type TextTarget } from "./doc.js";
import { EXPORT_FORMATS, exportDoc } from "./export.js";
import { Suggestions, Threads } from "./review.js";
import type { DocAccess } from "./service.js";
import { contextOf, INVITE_ROLES, parseSubject, ROLES } from "./share.js";

/** One table drives the CLI, the MCP server, and the HTTP API, so they stay the same. */
export interface Command {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  run(service: DocAccess, input: Record<string, unknown>, author: Principal | undefined, context?: PrincipalContext): Promise<unknown>;
}

const id = z.string().describe("Document id.");
const content = z.string().describe("Markdown for a section target. Plain text for a text target.");
const text = z.string().describe("Exact text to match. It must sit inside one block.");
const occurrence = z.coerce.number().int().min(1).optional().describe("Which match, counting from 1, when the text matches more than once.");
const side = z.enum(["before", "after"]).optional().describe("Put the new text before or after the match.");
const thread = z.string().describe("Thread id.");
const where = {
  section: z.string().optional().describe("Section id from the outline. Use this or text."),
  text: text.optional(),
  occurrence,
  at: z.enum(["start", "end", "before", "after"]).optional().describe("Insert at the start or end of a section, or before or after matched text."),
};

type Where = { section?: string; text?: string; occurrence?: number; at?: "start" | "end" | "before" | "after" };

function target(input: Where): Target {
  const { section, text, occurrence, at } = input;
  if (section !== undefined) {
    if (at !== undefined && at !== "start" && at !== "end") throw new DocError("INVALID_INPUT", `at "${at}" does not fit a section; use start or end`);
    return { section, at };
  }
  if (text !== undefined) {
    if (at === "start" || at === "end") throw new DocError("INVALID_INPUT", `at "${at}" does not fit text; use before or after`);
    return { text, occurrence, at };
  }
  throw new DocError("INVALID_INPUT", "pass section or text");
}

const textTarget = (input: { text: string; occurrence?: number; at?: "before" | "after" }): TextTarget => ({
  text: input.text,
  occurrence: input.occurrence,
  at: input.at,
});

function command<S extends z.ZodRawShape>(
  name: string,
  description: string,
  readOnly: boolean,
  shape: S,
  run: (service: DocAccess, input: z.infer<z.ZodObject<S>>, author: Principal, context?: PrincipalContext) => unknown,
): Command {
  return {
    name,
    description,
    shape,
    readOnly,
    async run(service, raw, author, context) {
      const parsed = z.object(shape).strict().safeParse(raw);
      if (!parsed.success) {
        throw new DocError("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
      }
      return run(service, parsed.data, author as Principal, context);
    },
  };
}

const ok = () => ({ ok: true });
const role = z.enum(ROLES).describe("viewer reads, commenter comments, editor writes, owner shares.");
const inviteRole = z.enum(INVITE_ROLES).describe("viewer, commenter, or editor. An invite never makes an owner.");
const flag = z.union([z.boolean(), z.enum(["true", "false"])]).transform((v) => v === true || v === "true");
const to = z.string().describe("Who: human:<id> for a person, agent:<id> for an agent.");
const OWNER_ONLY = " Only an owner may.";

export const commands: Command[] = [
  command("new", "Create a document, from Markdown if given. You own it.", false, { id, markdown: z.string().optional() }, async (s, i, a, c) => {
    await s.create(i.id, i.markdown ?? "", a, c);
    return { id: i.id };
  }),
  command("list", "List documents with their titles, creators, and last edits.", true, {}, (s) => s.list()),
  command("rename", "Give a document a title. The text stays.", false, { id, title: z.string().describe("1 to 120 characters of plain text.") }, async (s, i, a) => {
    await s.rename(i.id, i.title, a);
    return ok();
  }),
  command("remove", "Delete a whole document. A person may. An agent needs the docs:remove scope.", false, { id }, async (s, i, a) => {
    await s.remove(i.id, a);
    return ok();
  }),
  command("read", "Read a document, or one section, as Markdown.", true, { id, section: where.section }, (s, i) =>
    s.read(i.id, (d) => (i.section ? d.readSection(i.section) : d.toMarkdown())),
  ),
  command("outline", "List sections with their ids, levels, and titles.", true, { id }, (s, i) => s.read(i.id, (d) => d.outline())),
  command("edits", "Read the edit log. It names each author kind and holds no content.", true, { id }, (s, i) => s.read(i.id, (d) => d.edits())),
  command("insert", "Insert Markdown into a section, or plain text next to matched text.", false, { id, ...where, content }, async (s, i, a) => {
    await s.write(i.id, (d) => d.insert(target(i), i.content, a), a);
    return ok();
  }),
  command("replace", "Replace a section body (the heading stays), or the matched text.", false, { id, ...where, content }, async (s, i, a) => {
    await s.write(i.id, (d) => d.replace(target(i), i.content, a), a);
    return ok();
  }),
  command("delete", "Delete a section with its subsections, or the matched text.", false, { id, ...where }, async (s, i, a) => {
    await s.write(i.id, (d) => d.delete(target(i), a), a);
    return ok();
  }),
  command("append", "Add Markdown at the end of the document.", false, { id, content: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => d.append(i.content, a), a);
    return ok();
  }),
  command("suggest", "Suggest an edit to matched text. An empty replacement suggests a delete.", false, { id, text, occurrence, at: side, replacement: z.string() }, async (s, i, a) => ({
    suggestion: await s.write(i.id, (d) => new Suggestions(d).add(textTarget(i), i.replacement, a), a),
  })),
  command("suggestions", "List suggested edits.", true, { id, status: z.enum(["pending", "accepted", "rejected"]).optional() }, (s, i) =>
    s.read(i.id, (d) => new Suggestions(d).list({ status: i.status })),
  ),
  command("accept", "Accept a suggestion. The text changes now.", false, { id, suggestion: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => new Suggestions(d).accept(i.suggestion, a), a);
    return ok();
  }),
  command("reject", "Reject a suggestion. The text stays.", false, { id, suggestion: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => new Suggestions(d).reject(i.suggestion, a), a);
    return ok();
  }),
  command("comment", "Start a comment thread on matched text.", false, { id, text, occurrence, body: z.string() }, async (s, i, a) => ({
    thread: await s.write(i.id, (d) => new Threads(d).add(textTarget(i), i.body, a), a),
  })),
  command("reply", "Reply in a comment thread.", false, { id, thread, body: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => new Threads(d).reply(i.thread, i.body, a), a);
    return ok();
  }),
  command("resolve", "Resolve a comment thread.", false, { id, thread }, async (s, i, a) => {
    await s.write(i.id, (d) => new Threads(d).resolve(i.thread, a), a);
    return ok();
  }),
  command("reopen", "Reopen a comment thread.", false, { id, thread }, async (s, i, a) => {
    await s.write(i.id, (d) => new Threads(d).reopen(i.thread, a), a);
    return ok();
  }),
  command("threads", "List comment threads with their messages.", true, { id, status: z.enum(["open", "resolved"]).optional() }, (s, i) =>
    s.read(i.id, (d) => new Threads(d).list({ status: i.status })),
  ),
  command("export", "Export the document as Markdown (md), self-contained HTML (html), or OpenDocument text (odt, base64). HTML shows no remote image unless remoteImages is true.", true, { id, format: z.enum(EXPORT_FORMATS), remoteImages: z.union([z.boolean(), z.enum(["true", "false"])]).optional() }, (s, i) =>
    s.read(i.id, (d) => exportDoc(d, i.format, { remoteImages: i.remoteImages === true || i.remoteImages === "true" })),
  ),
  command("grants", "List who holds a role on a document." + OWNER_ONLY, true, { id }, (s, i, a, c) => s.sharing.grants(c ?? contextOf(a), i.id)),
  command("grant", "Give a person or an agent a role on a document. It replaces the role they hold." + OWNER_ONLY, false, { id, to, role }, async (s, i, a, c) => {
    await s.sharing.grant(c ?? contextOf(a), i.id, parseSubject(i.to), i.role);
    return ok();
  }),
  command("revoke", "Take a role away from a person or an agent." + OWNER_ONLY, false, { id, to }, async (s, i, a, c) => {
    await s.sharing.revoke(c ?? contextOf(a), i.id, parseSubject(i.to));
    return ok();
  }),
  command("invites", "List the invites on a document. It shows no email address." + OWNER_ONLY, true, { id }, (s, i, a, c) => s.sharing.invites(c ?? contextOf(a), i.id)),
  command(
    "invite",
    "Invite a person by email, or an agent by handle, to a document." + OWNER_ONLY,
    false,
    { id, role: inviteRole, email: z.string().optional(), handle: z.string().optional(), expiresInMs: z.coerce.number().int().optional().describe("How long the invite lasts, in milliseconds.") },
    async (s, i, a, c) => s.sharing.invite(c ?? contextOf(a), i.id, { role: i.role, email: i.email, handle: i.handle, expiresInMs: i.expiresInMs }),
  ),
  command(
    "link",
    "Make a share link token for a document. The token shows once." + OWNER_ONLY,
    false,
    { id, role: inviteRole, expiresAt: z.coerce.number().int().optional().describe("When the link ends, in epoch milliseconds."), signedInOnly: flag.optional().describe("Only a signed-in visitor may use it.") },
    async (s, i, a, c) => s.sharing.link(c ?? contextOf(a), i.id, { role: i.role, expiresAt: i.expiresAt, signedInOnly: i.signedInOnly }),
  ),
  command("unlink", "Revoke a share link." + OWNER_ONLY, false, { id, link: z.string().describe("Link id.") }, async (s, i, a, c) => {
    await s.sharing.unlink(c ?? contextOf(a), i.id, i.link);
    return ok();
  }),
];
