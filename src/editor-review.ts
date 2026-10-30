import { Actor, Comments, CommentsError, Suggestions, authorLabel, textAnchor, textOf } from "agentic-comments";
import type { Author, RelativePositionJson, SuggestionHost, TextAnchor } from "agentic-comments";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";

export { Actor, CommentsError, stamp } from "agentic-comments";
export type { Author, Suggestion, TextAnchor, Thread } from "agentic-comments";

const TEXTBLOCKS = new Set(["paragraph", "heading", "codeBlock"]);
/** Tiptap's default collaboration field. Review data uses the agentic-comments maps. */
function textBlocks(doc: Y.Doc): Y.XmlElement[] {
  const out: Y.XmlElement[] = [];
  const walk = (parent: Y.XmlFragment | Y.XmlElement) => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (TEXTBLOCKS.has(child.nodeName)) out.push(child);
      else walk(child);
    }
  };
  walk(doc.getXmlFragment("default"));
  return out;
}

const blocks = (doc: Y.Doc): (Y.XmlText | null)[] => textBlocks(doc).map(block =>
  block.toArray().find((c): c is Y.XmlText => c instanceof Y.XmlText) ?? null);

/** Plain text for search indexing: one line per paragraph, heading or code block. */
export const bodyText = (doc: Y.Doc): string => textBlocks(doc).map(block => block.toArray().map(child =>
  child instanceof Y.XmlText ? textOf(child) : child instanceof Y.XmlElement && child.nodeName === "hardBreak" ? "\n" : ""
).join("")).join("\n");

/** Pin a quote found exactly once within a text block. Missing or ambiguous quotes return null. */
export function anchorForQuote(doc: Y.Doc, quote: string): TextAnchor | null {
  if (quote === "") return null;
  let found: { text: Y.XmlText; at: number } | null = null;
  for (const text of blocks(doc)) {
    const own = text ? textOf(text) : "";
    for (let at = own.indexOf(quote); text && at >= 0; at = own.indexOf(quote, at + 1)) {
      if (found) return null;
      found = { text, at };
    }
  }
  return found && textAnchor(found.text, found.at, found.at + quote.length);
}

/** Pin an editor selection inside one plain text block, with no inline image or hard break. */
export function anchorOf(editor: Editor, doc: Y.Doc): { anchor: TextAnchor; quote: string } | { problem: string } {
  const { from, to, $from, $to } = editor.state.selection;
  if (from === to) return { problem: "Select some text to comment on." };
  const parent = $from.parent;
  let plain = true;
  parent.forEach(n => { plain &&= n.isText; });
  if (parent !== $to.parent || !parent.isTextblock || !plain) {
    return { problem: "Select text inside one line of text, with no image or line break." };
  }
  let index = -1, seen = 0;
  editor.state.doc.descendants(node => {
    if (node === parent) index = seen;
    if (node.isTextblock) seen += 1;
    return index < 0 && !node.isTextblock;
  });
  const text = blocks(doc)[index];
  if (!text) return { problem: "That text could not be pinned. Select it again." };
  const start = from - $from.start();
  const quote = textOf(text).slice(start, start + to - from);
  if (quote !== editor.state.doc.textBetween(from, to)) return { problem: "That text could not be pinned. Select it again." };
  return { anchor: textAnchor(text, start, start + to - from), quote };
}

/** Resolve a range in the editor field. Null means the range or its block is gone. Text may have changed. */
export function resolveAnchor(doc: Y.Doc, anchor: TextAnchor): { text: Y.XmlText; from: number; to: number } | null {
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), doc);
    const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end), doc);
    if (!a || !b || a.type !== b.type || !(a.type instanceof Y.XmlText) || a.index >= b.index || !blocks(doc).includes(a.type)) return null;
    return { text: a.type, from: a.index, to: b.index };
  } catch { return null; }
}

interface Receipt { start: RelativePositionJson; text: string }
const host: SuggestionHost = {
  parse(change, { anchor }) {
    const replacement = (change as { replacement?: unknown } | null)?.replacement;
    if (anchor.type !== "text" || typeof replacement !== "string") throw new CommentsError("APPLY_FAILED", "A text suggestion needs a replacement string.");
    if (JSON.stringify(replacement).length > 12_000) throw new CommentsError("APPLY_FAILED", "The replacement is too long.");
    return { replacement };
  },
  apply(change, { anchor, ydoc }): Receipt {
    const replacement = (change as { replacement: string }).replacement;
    const at = anchor.type === "text" ? resolveAnchor(ydoc, anchor) : null;
    if (!at || anchor.type !== "text" || textOf(at.text).slice(at.from, at.to) !== anchor.text) {
      throw new CommentsError("APPLY_FAILED", "The text changed, so the suggestion cannot apply.");
    }
    // Check receipt size before editing: Yjs transactions do not roll back on failure.
    if (JSON.stringify(replacement).length > 12_000) throw new CommentsError("APPLY_FAILED", "The replacement is too long.");
    let offset = 0;
    let attributes: Record<string, unknown> = {};
    for (const part of at.text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
      offset += typeof part.insert === "string" ? part.insert.length : 1;
      if (offset > at.from) { attributes = part.attributes ?? {}; break; }
    }
    at.text.delete(at.from, at.to - at.from);
    at.text.insert(at.from, replacement, attributes);
    return { start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(at.text, at.from)), text: replacement };
  },
  revert(receipt, { ydoc }) {
    const { start, text } = (receipt ?? {}) as Partial<Receipt>;
    const at = start && typeof text === "string" ? Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(start), ydoc) : null;
    if (!at || !(at.type instanceof Y.XmlText) || !blocks(ydoc).includes(at.type) || textOf(at.type).slice(at.index, at.index + text!.length) !== text) {
      throw new Error("The receipt does not match the document.");
    }
    at.type.delete(at.index, text!.length);
  },
};

/** Synchronous review controller. Close it when the host releases the document. */
export function createReview(doc: Y.Doc, actor: Actor) {
  if (!Actor.is(actor)) throw new CommentsError("INVALID_AUTHOR", "Use stamp() with the authenticated principal.");
  const comments = new Comments(doc);
  const suggestions = new Suggestions(comments, host);
  return {
    actor,
    get threads() { return comments.list(); },
    get suggestions() { return suggestions.list(); },
    comment: (anchor: TextAnchor, body: string) => comments.add({ anchor, body }, actor),
    /** Pass a stamped agent as `as` to keep machine proposals labeled as machine work. */
    suggest: (anchor: TextAnchor, replacement: string, as: Actor = actor) => suggestions.add({ anchor, change: { replacement } }, as),
    reply: (thread: string, body: string) => comments.reply(thread, { body }, actor),
    setResolved: (thread: string, resolved: boolean) => resolved ? comments.resolve(thread, actor) : comments.reopen(thread, actor),
    decide(suggestion: string, accept: boolean) {
      const s = suggestions.get(suggestion);
      if (s.author.kind !== "human" && s.author.name === actor.name) {
        throw new CommentsError("FORBIDDEN", "An agent author cannot decide its own suggestion.");
      }
      return accept ? suggestions.accept(suggestion, actor) : suggestions.reject(suggestion, actor);
    },
    /** Subscribe to local and remote changes. Returns an unsubscribe function. */
    subscribe(listener: () => void) { doc.on("update", listener); return () => doc.off("update", listener); },
    problems: () => suggestions.problems(),
    close: () => suggestions.close(),
  };
}
export type Review = ReturnType<typeof createReview>;
/** A safe message for a review error shown in the host UI. */
export const explainReview = (error: unknown): string => error instanceof CommentsError ? error.message : "That did not work. Nothing was changed.";
/** Mark known machine identities as agent work, regardless of stored kind. */
export const labelOf = (author: Author, machineNames: ReadonlySet<string>): string => machineNames.has(author.name) ? "agent" : authorLabel(author);
