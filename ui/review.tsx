import { useEffect, useReducer, useState } from "react";
import { checkAuthor, type AgenticDoc, type Principal, type Anchor } from "../src/doc.js";
import { Suggestions, Threads, ACCEPT_SCOPE, isPerson } from "../src/review.js";

export interface ReviewPanelOptions {
  /** The same engine document that backs the editor's host.doc. The host saves it. */
  doc: AgenticDoc;
  principal: Principal;
  /** Explicit host permission. Defaults to read only. Server authorization still applies. */
  writable?: boolean;
  mode?: "review" | "suggest";
  onModeChange?: (mode: "review" | "suggest") => void;
  /** Called to reveal the range in the host editor. Stale anchors cannot be opened. */
  onAnchor?: (anchor: Anchor) => void;
}

function useDocumentUpdates(doc: AgenticDoc) {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const update = () => refresh();
    doc.ydoc.on("update", update);
    return () => { doc.ydoc.off("update", update); };
  }, [doc]);
}

/** A keyboard reachable comment range. A stale anchor stays visible as plain text. */
export function CommentAnchor({ doc, anchor, onAnchor }: { doc: AgenticDoc; anchor: Anchor; onAnchor?: (anchor: Anchor) => void }) {
  useDocumentUpdates(doc);
  let stale = false;
  try { doc.resolve({ anchor }); } catch { stale = true; }
  return stale ? <span>Unavailable anchor: {anchor.text}</span> : onAnchor
    ? <button type="button" onClick={() => onAnchor(anchor)}>Show text: {anchor.text}</button>
    : <span>Text: {anchor.text}</span>;
}

const authorLabel = (who: Principal) => `${who.kind === "human" ? "Person" : "Machine-made"}: ${who.name} (${who.kind})`;

/** Review and propose edits without changing text until a different principal accepts. */
export function ReviewPanel({ doc, principal, writable = false, mode = "review", onModeChange, onAnchor }: ReviewPanelOptions) {
  checkAuthor(principal);
  useDocumentUpdates(doc);
  const [currentMode, setMode] = useState(mode);
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setMode(mode); }, [mode]);
  const suggestions = new Suggestions(doc);
  const threads = new Threads(doc);
  const run = (action: () => unknown) => {
    try { action(); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Review failed"); }
  };
  return <section aria-label="Document review" className="agd-doc">
    <label>Review mode <select value={currentMode} onChange={(event) => {
      const next = event.target.value as "review" | "suggest";
      setMode(next); onModeChange?.(next);
    }}><option value="review">Review</option><option value="suggest">Suggest</option></select></label>
    {error && <p role="alert">{error}</p>}
    {currentMode === "suggest" && <form onSubmit={(event) => {
      event.preventDefault();
      if (writable === true) run(() => suggestions.add({ text }, replacement, principal));
    }}>
      <label>Exact text <input value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label>Proposed Markdown <textarea value={replacement} onChange={(event) => setReplacement(event.target.value)} /></label>
      <button type="submit" disabled={writable !== true}>Propose suggestion</button>
    </form>}
    <h2>Suggestions</h2>
    {suggestions.list().map((s) => {
      const different = s.author.kind !== principal.kind || s.author.name !== principal.name;
      const permitted = writable === true && different && (isPerson(principal) || principal.scopes?.includes(ACCEPT_SCOPE) === true) && s.status === "pending";
      return <article key={s.id} aria-label={`Suggestion by ${s.author.name}`}>
        <p>{authorLabel(s.author)}</p>
        <p>{s.kind}: <q>{s.anchor.text}</q></p>
        <pre>{s.replacement}</pre>
        <p>{s.status}{s.stale && s.status === "pending" ? " — Stale anchor" : ""}</p>
        <button type="button" disabled={!permitted || s.stale} onClick={() => run(() => suggestions.accept(s.id, principal))}>Accept</button>
        <button type="button" disabled={!permitted} onClick={() => run(() => suggestions.reject(s.id, principal))}>Reject</button>
      </article>;
    })}
    <h2>Comments</h2>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (writable === true) run(() => threads.add({ text }, comment, principal));
    }}>
      <label>Comment text target <input value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label>Comment <textarea value={comment} onChange={(event) => setComment(event.target.value)} /></label>
      <button type="submit" disabled={writable !== true}>Add comment</button>
    </form>
    {threads.list().map((thread) => <article key={thread.id} aria-label="Comment thread">
      <CommentAnchor doc={doc} anchor={thread.anchor} onAnchor={onAnchor} />
      {thread.messages.map((message) => <p key={message.id}>{authorLabel(message.author)}: {message.body}</p>)}
    </article>)}
  </section>;
}
