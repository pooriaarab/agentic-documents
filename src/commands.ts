import { z } from "zod";
import { DocError, type Principal, type Target, type TextTarget } from "./doc.js";
import { EXPORT_FORMATS, exportDoc } from "./export.js";
import { Suggestions, Threads } from "./review.js";
import type { DocsService } from "./service.js";

/** One table drives the CLI, the MCP server, and the HTTP API, so they stay the same. */
export interface Command {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  run(service: DocsService, input: Record<string, unknown>, author: Principal | undefined): Promise<unknown>;
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
  run: (service: DocsService, input: z.infer<z.ZodObject<S>>, author: Principal) => unknown,
): Command {
  return {
    name,
    description,
    shape,
    readOnly,
    async run(service, raw, author) {
      const parsed = z.object(shape).strict().safeParse(raw);
      if (!parsed.success) {
        throw new DocError("INVALID_INPUT", parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
      }
      return run(service, parsed.data, author as Principal);
    },
  };
}

const ok = () => ({ ok: true });

export const commands: Command[] = [
  command("new", "Create a document, from Markdown if given.", false, { id, markdown: z.string().optional() }, async (s, i, a) => {
    await s.create(i.id, i.markdown ?? "", a);
    return { id: i.id };
  }),
  command("read", "Read a document, or one section, as Markdown.", true, { id, section: where.section }, (s, i) =>
    s.read(i.id, (d) => (i.section ? d.readSection(i.section) : d.toMarkdown())),
  ),
  command("outline", "List sections with their ids, levels, and titles.", true, { id }, (s, i) => s.read(i.id, (d) => d.outline())),
  command("edits", "Read the edit log. It names each author kind and holds no content.", true, { id }, (s, i) => s.read(i.id, (d) => d.edits())),
  command("insert", "Insert Markdown into a section, or plain text next to matched text.", false, { id, ...where, content }, async (s, i, a) => {
    await s.write(i.id, (d) => d.insert(target(i), i.content, a));
    return ok();
  }),
  command("replace", "Replace a section body (the heading stays), or the matched text.", false, { id, ...where, content }, async (s, i, a) => {
    await s.write(i.id, (d) => d.replace(target(i), i.content, a));
    return ok();
  }),
  command("delete", "Delete a section with its subsections, or the matched text.", false, { id, ...where }, async (s, i, a) => {
    await s.write(i.id, (d) => d.delete(target(i), a));
    return ok();
  }),
  command("append", "Add Markdown at the end of the document.", false, { id, content: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => d.append(i.content, a));
    return ok();
  }),
  command("suggest", "Suggest an edit to matched text. An empty replacement suggests a delete.", false, { id, text, occurrence, at: side, replacement: z.string() }, async (s, i, a) => ({
    suggestion: await s.write(i.id, (d) => new Suggestions(d).add(textTarget(i), i.replacement, a)),
  })),
  command("suggestions", "List suggested edits.", true, { id, status: z.enum(["pending", "accepted", "rejected"]).optional() }, (s, i) =>
    s.read(i.id, (d) => new Suggestions(d).list({ status: i.status })),
  ),
  command("accept", "Accept a suggestion. The text changes now.", false, { id, suggestion: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => new Suggestions(d).accept(i.suggestion, a));
    return ok();
  }),
  command("reject", "Reject a suggestion. The text stays.", false, { id, suggestion: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => new Suggestions(d).reject(i.suggestion, a));
    return ok();
  }),
  command("comment", "Start a comment thread on matched text.", false, { id, text, occurrence, body: z.string() }, async (s, i, a) => ({
    thread: await s.write(i.id, (d) => new Threads(d).add(textTarget(i), i.body, a)),
  })),
  command("reply", "Reply in a comment thread.", false, { id, thread, body: z.string() }, async (s, i, a) => {
    await s.write(i.id, (d) => new Threads(d).reply(i.thread, i.body, a));
    return ok();
  }),
  command("resolve", "Resolve a comment thread.", false, { id, thread }, async (s, i, a) => {
    await s.write(i.id, (d) => new Threads(d).resolve(i.thread, a));
    return ok();
  }),
  command("reopen", "Reopen a comment thread.", false, { id, thread }, async (s, i, a) => {
    await s.write(i.id, (d) => new Threads(d).reopen(i.thread, a));
    return ok();
  }),
  command("threads", "List comment threads with their messages.", true, { id, status: z.enum(["open", "resolved"]).optional() }, (s, i) =>
    s.read(i.id, (d) => new Threads(d).list({ status: i.status })),
  ),
  command("export", "Export the document as Markdown (md) or self-contained HTML (html).", true, { id, format: z.enum(EXPORT_FORMATS) }, (s, i) =>
    s.read(i.id, (d) => exportDoc(d, i.format)),
  ),
];
