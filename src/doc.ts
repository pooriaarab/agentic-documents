import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from "y-prosemirror";
import * as Y from "yjs";
import { DocError } from "./errors.js";
import { blocksToMarkdown, markdownToBlocks, type PmNode } from "./markdown.js";
import { PRINCIPAL_KINDS, type PrincipalKind } from "agentic-identity";
import { schema } from "./schema.js";
import { APPLIED, settle } from "./settle.js";

export { DocError, type DocErrorCode } from "./errors.js";

/** The id of the blocks before the first heading. Heading ids start with `s`, so they never match. */
export const PREAMBLE = "preamble";
const FRAGMENT = "default";
const CONTEXT_CHARS = 20;

export { PRINCIPAL_KINDS, type PrincipalKind } from "agentic-identity";

/** Who made a change. Every mutation needs one, so machine-made work stays labeled. */
export interface Principal {
  kind: PrincipalKind;
  name: string;
  /** Rights this principal was granted, such as `docs:accept`. Used to decide, never stored in the doc. */
  scopes?: string[];
}

/** A text range that follows its text through concurrent edits. */
export interface Anchor {
  text: string;
  start: Record<string, unknown>;
  end: Record<string, unknown>;
}

export type TextTarget = { text: string; occurrence?: number; at?: "before" | "after" };
export type AnchorTarget = { anchor: Anchor; at?: "before" | "after" };
export type SectionTarget = { section: string; at?: "start" | "end" };
export type Target = TextTarget | AnchorTarget | SectionTarget;

export interface Section {
  id: string;
  level: number;
  title: string;
}

export interface EditEntry {
  /** `live` ties the editor client of an agent to that agent, so the text the client types is marked as its work. Its counts stay 0. */
  op: "create" | "append" | "insert" | "replace" | "delete" | "live";
  at: string;
  author: Principal;
  /** Counts of characters (text targets) or blocks (section targets). Never content. */
  inserted: number;
  deleted: number;
  section?: string;
  /** The Yjs client id of the replica that made the edit. Text it wrote carries this id, so a UI can mark text by author kind. Written by the client, like the rest of the log. */
  client?: number;
  /** Set when an accepted suggestion caused the edit. `author` is who suggested it. */
  suggestion?: { id: string; author: Principal };
}

/** When the edit was logged, and where it put new text (relative positions that follow the text). */
export interface EditResult {
  at: string;
  inserted?: { start: Record<string, unknown>; end: Record<string, unknown> };
}

export interface DocOptions {
  now?: () => Date;
}

type Attrs = Record<string, unknown>;
type Range = { unit: Y.XmlText; start: number; end: number };

const isSection = (t: Target): t is SectionTarget => "section" in t;
const isAnchor = (t: Target): t is AnchorTarget => "anchor" in t;

export function checkAuthor(author: Principal): Principal {
  const scopes = (author as { scopes?: unknown } | null)?.scopes;
  const ok =
    typeof author === "object" &&
    author !== null &&
    PRINCIPAL_KINDS.includes(author.kind) &&
    typeof author.name === "string" &&
    author.name.trim() !== "" &&
    (scopes === undefined || (Array.isArray(scopes) && scopes.every((s) => typeof s === "string" && s !== "")));
  if (!ok) throw new DocError("INVALID_AUTHOR", `author needs a kind (${PRINCIPAL_KINDS.join(", ")}), a name, and scopes that are a list of text`);
  return { kind: author.kind, name: author.name };
}

/** `kind:name`, for example `agent_of_human:scribe`. Validation happens when a change needs it. */
export function parseAuthor(value: string | undefined): Principal | undefined {
  if (value === undefined) return undefined;
  const cut = value.indexOf(":");
  return { kind: (cut < 0 ? value : value.slice(0, cut)) as PrincipalKind, name: cut < 0 ? "" : value.slice(cut + 1) };
}

const unitText = (unit: Y.XmlText): string =>
  unit
    .toDelta()
    .map((d: { insert: unknown }) => (typeof d.insert === "string" ? d.insert : ""))
    .join("");

function unitsOf(node: Y.XmlFragment | Y.XmlElement): Y.XmlText[] {
  return node.toArray().flatMap((child) => (child instanceof Y.XmlText ? [child] : child instanceof Y.XmlElement ? unitsOf(child) : []));
}

function attrsAt(unit: Y.XmlText, index: number): Attrs {
  let pos = 0;
  for (const op of unit.toDelta() as { insert: unknown; attributes?: Attrs }[]) {
    pos += typeof op.insert === "string" ? op.insert.length : 1;
    if (index < pos) return { ...op.attributes };
  }
  return {};
}

function sectionId(el: Y.XmlElement): string {
  const { client, clock } = (el as unknown as { _item: { id: { client: number; clock: number } } })._item.id;
  return `s${client.toString(36)}-${clock}`;
}

function toYBlocks(content: PmNode[]): Y.XmlElement[] {
  const scratch = new Y.Doc().getXmlFragment(FRAGMENT);
  prosemirrorJSONToYXmlFragment(schema, { type: "doc", content }, scratch);
  return scratch.toArray().map((el) => (el as Y.XmlElement).clone());
}

export class AgenticDoc {
  readonly ydoc: Y.Doc;
  readonly now: () => Date;

  constructor(ydoc: Y.Doc = new Y.Doc(), options: DocOptions = {}) {
    this.ydoc = ydoc;
    this.now = options.now ?? (() => new Date());
    // A merge can bring in two applications of one suggestion. Settle them on every replica the same way.
    const watched: Y.AbstractType<any>[] = [ydoc.getMap(APPLIED), ydoc.getMap("suggestions")];
    ydoc.on("afterTransaction", (tr) => {
      if (!tr.local && watched.some((type) => tr.changedParentTypes.has(type))) settle(ydoc);
    });
  }

  static fromMarkdown(markdown: string, author: Principal, options?: DocOptions): AgenticDoc {
    checkAuthor(author);
    return AgenticDoc.fromBlocks(markdownToBlocks(markdown), author, options);
  }

  /** Make a document from blocks in ProseMirror JSON form. Blocks that the schema does not allow fail with INVALID_INPUT. */
  static fromBlocks(content: PmNode[], author: Principal, options?: DocOptions): AgenticDoc {
    const who = checkAuthor(author);
    try {
      if (content.length > 0) schema.nodeFromJSON({ type: "doc", content }).check(); // an empty document is allowed
    } catch (error) {
      throw new DocError("INVALID_INPUT", `the blocks do not fit the document schema: ${error instanceof Error ? error.message : String(error)}`);
    }
    const doc = new AgenticDoc(new Y.Doc(), options);
    doc.change("create", who, () => {
      doc.fragment.insert(0, toYBlocks(content));
      return { inserted: content.length, deleted: 0 };
    });
    return doc;
  }

  static fromUpdate(update: Uint8Array, options?: DocOptions): AgenticDoc {
    const doc = new AgenticDoc(new Y.Doc(), options);
    doc.applyUpdate(update);
    return doc;
  }

  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc);
  }

  applyUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update);
  }

  /** A new replica with its own client id, holding the same state. */
  fork(): AgenticDoc {
    return AgenticDoc.fromUpdate(this.encode(), { now: this.now });
  }

  private get fragment(): Y.XmlFragment {
    return this.ydoc.getXmlFragment(FRAGMENT);
  }

  private get log(): Y.Array<EditEntry> {
    return this.ydoc.getArray<EditEntry>("edits");
  }

  edits(): EditEntry[] {
    return this.log.toArray();
  }

  private change(
    op: EditEntry["op"],
    author: Principal,
    run: () => Pick<EditEntry, "inserted" | "deleted" | "section">,
    extra: Pick<EditEntry, "suggestion"> = {},
  ): string {
    const at = this.now().toISOString();
    this.ydoc.transact(() => {
      const entry: EditEntry = { op, at, author, client: this.ydoc.clientID, ...run(), ...extra };
      if (entry.section === undefined) delete entry.section;
      this.log.push([entry]);
    });
    return at;
  }

  toJSON(): PmNode {
    return yXmlFragmentToProsemirrorJSON(this.fragment) as PmNode;
  }

  toMarkdown(): string {
    return blocksToMarkdown(this.toJSON().content ?? []);
  }

  /** Sections in order. Blocks before the first heading come first, as the `preamble` section at level 0. */
  outline(): Section[] {
    const headings = this.headings();
    const sections = headings.map(({ el }) => ({
      id: sectionId(el),
      level: Number(el.getAttribute("level") ?? 1),
      title: unitsOf(el).map(unitText).join(""),
    }));
    const before = headings.length ? headings[0].index : this.fragment.length;
    return before > 0 ? [{ id: PREAMBLE, level: 0, title: "Preamble" }, ...sections] : sections;
  }

  readSection(id: string): string {
    const { start, end } = this.range(id);
    return blocksToMarkdown((this.toJSON().content ?? []).slice(start, end));
  }

  private headings(): { el: Y.XmlElement; index: number }[] {
    return this.fragment
      .toArray()
      .flatMap((el, index) => (el instanceof Y.XmlElement && el.nodeName === "heading" ? [{ el, index }] : []));
  }

  /**
   * A section runs from its heading to the next heading of the same or a higher level. The preamble
   * has no heading and runs to the first heading. It is always a valid target, even when empty.
   */
  private range(id: string): { start: number; end: number; headed: boolean } {
    const all = this.headings();
    if (id === PREAMBLE) return { start: 0, end: all.length ? all[0].index : this.fragment.length, headed: false };
    const at = all.findIndex(({ el }) => sectionId(el) === id);
    if (at < 0) throw new DocError("NO_SECTION", `no section with id "${id}"`);
    const level = Number(all[at].el.getAttribute("level") ?? 1);
    const next = all.slice(at + 1).find(({ el }) => Number(el.getAttribute("level") ?? 1) <= level);
    return { start: all[at].index, end: next ? next.index : this.fragment.length, headed: true };
  }

  private find(text: string): Range[] {
    if (text === "") return [];
    return unitsOf(this.fragment).flatMap((unit) => {
      const found: Range[] = [];
      const value = unitText(unit);
      for (let at = value.indexOf(text); at >= 0; at = value.indexOf(text, at + 1)) {
        found.push({ unit, start: at, end: at + text.length });
      }
      return found;
    });
  }

  private pick(text: string, occurrence?: number): Range {
    const found = this.find(text);
    if (found.length === 0) throw new DocError("NO_MATCH", `no text matches "${text}"`);
    if (occurrence !== undefined) {
      if (found[occurrence - 1] === undefined) throw new DocError("NO_MATCH", `"${text}" has ${found.length} matches, not ${occurrence}`);
      return found[occurrence - 1];
    }
    if (found.length > 1) {
      const matches = found.map((m, i) => {
        const value = unitText(m.unit);
        return { occurrence: i + 1, context: value.slice(Math.max(0, m.start - CONTEXT_CHARS), m.end + CONTEXT_CHARS) };
      });
      throw new DocError("AMBIGUOUS_MATCH", `"${text}" matches ${found.length} places; pass an occurrence`, matches);
    }
    return found[0];
  }

  /** Pin a text range so later edits by other replicas do not move it. */
  anchor(text: string, occurrence?: number): Anchor {
    const { unit, start, end } = this.pick(text, occurrence);
    return {
      text,
      start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(unit, start, 0)),
      end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(unit, end, -1)),
    };
  }

  resolve(target: TextTarget | AnchorTarget): Range {
    if (!isAnchor(target)) return this.pick(target.text, target.occurrence);
    const { anchor } = target;
    const start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), this.ydoc);
    const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end), this.ydoc);
    const unit = start?.type;
    if (!(unit instanceof Y.XmlText) || end?.type !== unit || unitText(unit).slice(start!.index, end.index) !== anchor.text) {
      throw new DocError("STALE_ANCHOR", `the anchored text "${anchor.text}" changed or was removed`);
    }
    return { unit, start: start!.index, end: end.index };
  }

  edit(
    op: "insert" | "replace" | "delete",
    target: TextTarget | AnchorTarget,
    content: string,
    author: Principal,
    extra: Pick<EditEntry, "suggestion"> = {},
  ): EditResult {
    const who = checkAuthor(author);
    const { unit, start, end } = this.resolve(target);
    let inserted: EditResult["inserted"];
    const at = this.change(op, who, () => {
      const marks = attrsAt(unit, op === "insert" && target.at !== "before" ? end - 1 : start);
      if (op === "insert") delete marks.link;
      const index = op === "insert" ? (target.at === "before" ? start : end) : start;
      if (op !== "insert") unit.delete(start, end - start);
      if (op !== "delete") {
        unit.insert(index, content, marks);
        inserted = {
          start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(unit, index, 0)),
          end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(unit, index + content.length, -1)),
        };
      }
      return { inserted: op === "delete" ? 0 : content.length, deleted: op === "insert" ? 0 : end - start };
    }, extra);
    return { at, inserted };
  }

  private editSection(op: "insert" | "replace" | "delete", target: SectionTarget, markdown: string, author: Principal): void {
    const who = checkAuthor(author);
    const { start, end, headed } = this.range(target.section);
    const body = headed ? start + 1 : start;
    const content = op === "delete" ? [] : markdownToBlocks(markdown);
    this.change(op, who, () => {
      const deleted = op === "insert" ? 0 : op === "delete" ? end - start : end - body;
      const from = op === "delete" ? start : op === "replace" || target.at === "start" ? body : end;
      if (op === "replace") this.fragment.delete(body, end - body);
      if (op === "delete") this.fragment.delete(start, end - start);
      if (content.length) this.fragment.insert(from, toYBlocks(content));
      return { inserted: content.length, deleted, section: target.section };
    });
  }

  /** Insert Markdown into a section, or plain text next to matched text. */
  insert(target: Target, content: string, author: Principal): void {
    if (isSection(target)) this.editSection("insert", target, content, author);
    else this.edit("insert", target, content, author);
  }

  /** Replace a section body (the heading stays), or the matched text. */
  replace(target: Target, content: string, author: Principal): void {
    if (isSection(target)) this.editSection("replace", target, content, author);
    else this.edit("replace", target, content, author);
  }

  /** Delete a whole section with its subsections, or the matched text. */
  delete(target: Target, author: Principal): void {
    if (isSection(target)) this.editSection("delete", target, "", author);
    else this.edit("delete", target, "", author);
  }

  append(markdown: string, author: Principal): void {
    const who = checkAuthor(author);
    const content = markdownToBlocks(markdown);
    this.change("append", who, () => {
      this.fragment.insert(this.fragment.length, toYBlocks(content));
      return { inserted: content.length, deleted: 0 };
    });
  }
}
