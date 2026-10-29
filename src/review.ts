import * as Y from "yjs";
import { APPLIED, type Application } from "./settle.js";
import { checkAuthor, DocError, type AgenticDoc, type Anchor, type AnchorTarget, type Principal, type TextTarget } from "./doc.js";

export interface Message {
  id: string;
  at: string;
  author: Principal;
  body: string;
}

export interface Thread {
  id: string;
  anchor: Anchor;
  status: "open" | "resolved";
  resolvedBy?: Principal;
  resolvedAt?: string;
  messages: Message[];
  /** The anchored text no longer matches what the comment was made on. */
  stale: boolean;
  /** The text now under the anchor, or null when it is gone. */
  currentText: string | null;
}

export interface Suggestion {
  id: string;
  kind: "insert" | "replace" | "delete";
  at?: "before" | "after";
  anchor: Anchor;
  replacement: string;
  author: Principal;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
  decidedBy?: Principal;
  decidedAt?: string;
  stale: boolean;
}

type Fields = Y.Map<unknown>;

const newId = (): string => globalThis.crypto.randomUUID();

function nonEmpty(value: string, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new DocError("INVALID_INPUT", `${what} must not be empty`);
  return value;
}

/** Make an anchor from a text target, or check that a given anchor still resolves. */
function anchorFor(doc: AgenticDoc, target: TextTarget | AnchorTarget): Anchor {
  if ("anchor" in target) {
    doc.resolve(target);
    return target.anchor;
  }
  return doc.anchor(target.text, target.occurrence);
}

function isStale(doc: AgenticDoc, anchor: Anchor): { stale: boolean; currentText: string | null } {
  try {
    doc.resolve({ anchor });
    return { stale: false, currentText: anchor.text };
  } catch (error) {
    if (!(error instanceof DocError) || error.code !== "STALE_ANCHOR") throw error;
    return { stale: true, currentText: null };
  }
}

function fieldsOf(doc: AgenticDoc, name: string): Y.Map<Fields> {
  return doc.ydoc.getMap<Fields>(name);
}

const optional = (map: Fields, key: string) => (map.has(key) ? { [key]: map.get(key) } : {});

function setAll(map: Fields, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) if (value !== undefined) map.set(key, value);
}

/** Comment threads anchored to text. Replies and status merge across replicas. */
export class Threads {
  constructor(private readonly doc: AgenticDoc) {}

  private get map(): Y.Map<Fields> {
    return fieldsOf(this.doc, "threads");
  }

  private get(id: string): Fields {
    const thread = this.map.get(id);
    if (!thread) throw new DocError("NO_THREAD", `no thread with id "${id}"`);
    return thread;
  }

  private message(body: string, author: Principal): Message {
    return { id: newId(), at: this.doc.now().toISOString(), author, body };
  }

  add(target: TextTarget | AnchorTarget, body: string, author: Principal): string {
    const who = checkAuthor(author);
    nonEmpty(body, "a comment");
    const anchor = anchorFor(this.doc, target);
    const id = newId();
    this.doc.ydoc.transact(() => {
      const thread: Fields = new Y.Map();
      this.map.set(id, thread);
      setAll(thread, { anchor, status: "open" });
      const messages = new Y.Array<Message>();
      thread.set("messages", messages);
      messages.push([this.message(body, who)]);
    });
    return id;
  }

  reply(id: string, body: string, author: Principal): void {
    const who = checkAuthor(author);
    nonEmpty(body, "a reply");
    (this.get(id).get("messages") as Y.Array<Message>).push([this.message(body, who)]);
  }

  private setStatus(id: string, status: "open" | "resolved", author: Principal): void {
    const who = checkAuthor(author);
    const thread = this.get(id);
    this.doc.ydoc.transact(() => {
      thread.set("status", status);
      if (status === "open") {
        thread.delete("resolvedBy");
        thread.delete("resolvedAt");
      } else setAll(thread, { resolvedBy: who, resolvedAt: this.doc.now().toISOString() });
    });
  }

  resolve(id: string, author: Principal): void {
    this.setStatus(id, "resolved", author);
  }

  reopen(id: string, author: Principal): void {
    this.setStatus(id, "open", author);
  }

  list(filter: { status?: Thread["status"] } = {}): Thread[] {
    return [...this.map.entries()]
      .map(([id, t]): Thread => {
        const anchor = t.get("anchor") as Anchor;
        return {
          id,
          anchor,
          status: t.get("status") as Thread["status"],
          ...optional(t, "resolvedBy"),
          ...optional(t, "resolvedAt"),
          messages: (t.get("messages") as Y.Array<Message>).toArray(),
          ...isStale(this.doc, anchor),
        };
      })
      .filter((t) => filter.status === undefined || t.status === filter.status)
      .sort((a, b) => a.messages[0].at.localeCompare(b.messages[0].at) || a.id.localeCompare(b.id));
  }
}

export const ACCEPT_SCOPE = "docs:accept";

const sameWho = (a: Principal, b: Principal): boolean => a.kind === b.kind && a.name === b.name;

export const isPerson = (who: Principal): boolean => who.kind === "human" || who.kind === "user_token";

/** A person or a user token decides. An agent needs the accept scope. Roles come later with the Auth port. */
const mayDecide = (who: Principal): boolean => isPerson(who) || who.scopes?.includes(ACCEPT_SCOPE) === true;

/** Suggested edits. Nothing changes in the text until a person, or an agent with the accept scope, accepts one. */
export class Suggestions {
  constructor(private readonly doc: AgenticDoc) {}

  private get map(): Y.Map<Fields> {
    return fieldsOf(this.doc, "suggestions");
  }

  private get(id: string): { fields: Fields; suggestion: Suggestion } {
    const fields = this.map.get(id);
    if (!fields) throw new DocError("NO_SUGGESTION", `no suggestion with id "${id}"`);
    return { fields, suggestion: this.read(id, fields) };
  }

  private read(id: string, f: Fields): Suggestion {
    const anchor = f.get("anchor") as Anchor;
    return {
      id,
      kind: f.get("kind") as Suggestion["kind"],
      ...optional(f, "at"),
      anchor,
      replacement: f.get("replacement") as string,
      author: f.get("author") as Principal,
      createdAt: f.get("createdAt") as string,
      status: f.get("status") as Suggestion["status"],
      ...optional(f, "decidedBy"),
      ...optional(f, "decidedAt"),
      stale: isStale(this.doc, anchor).stale,
    };
  }

  /** An `at` on the target means insert. An empty replacement means delete. */
  add(target: TextTarget | AnchorTarget, replacement: string, author: Principal): string {
    const who = checkAuthor(author);
    const kind: Suggestion["kind"] = target.at ? "insert" : replacement === "" ? "delete" : "replace";
    if (kind === "insert") nonEmpty(replacement, "an inserted text");
    const anchor = anchorFor(this.doc, target);
    const id = newId();
    this.doc.ydoc.transact(() => {
      const fields: Fields = new Y.Map();
      this.map.set(id, fields);
      setAll(fields, { kind, at: target.at, anchor, replacement, author: who, createdAt: this.doc.now().toISOString(), status: "pending" });
    });
    return id;
  }

  private decide(fields: Fields, status: "accepted" | "rejected", author: Principal, at: string): void {
    setAll(fields, { status, decidedBy: author, decidedAt: at });
  }

  /**
   * Apply the edit as the accepting author. The check and the edit share one transaction. Accepting
   * an accepted suggestion changes nothing. A stale anchor throws and the suggestion stays pending.
   */
  accept(id: string, author: Principal): void {
    const who = checkAuthor(author);
    this.doc.ydoc.transact(() => {
      const { fields, suggestion: s } = this.get(id);
      if (!mayDecide(author) || sameWho(s.author, who)) {
        throw new DocError("FORBIDDEN", `${who.kind}:${who.name} cannot accept this suggestion: a person who is not its author, or an agent with the ${ACCEPT_SCOPE} scope, can`);
      }
      if (s.status === "accepted") return;
      if (s.status !== "pending") throw new DocError("ALREADY_DECIDED", `suggestion "${id}" is already ${s.status}`);
      const { at, inserted } = this.doc.edit(s.kind, { anchor: s.anchor, at: s.at }, s.replacement, who, { suggestion: { id, author: s.author } });
      const record: Application = { by: who, at, ...inserted };
      this.doc.ydoc.getMap<Application>(APPLIED).set(`${id}:${this.doc.ydoc.clientID}`, record);
      this.decide(fields, "accepted", who, at);
    });
  }

  /** Same right as accept. A person can withdraw their own suggestion. An agent can never decide its own. */
  reject(id: string, author: Principal): void {
    const who = checkAuthor(author);
    this.doc.ydoc.transact(() => {
      const { fields, suggestion: s } = this.get(id);
      if (!mayDecide(author) || (!isPerson(who) && sameWho(s.author, who))) {
        throw new DocError("FORBIDDEN", `${who.kind}:${who.name} cannot reject this suggestion: a person, or an agent with the ${ACCEPT_SCOPE} scope that did not write it, can`);
      }
      if (s.status !== "pending") throw new DocError("ALREADY_DECIDED", `suggestion "${id}" is already ${s.status}`);
      this.decide(fields, "rejected", who, this.doc.now().toISOString());
    });
  }

  list(filter: { status?: Suggestion["status"] } = {}): Suggestion[] {
    return [...this.map.entries()]
      .map(([id, f]) => this.read(id, f))
      .filter((s) => filter.status === undefined || s.status === filter.status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}
