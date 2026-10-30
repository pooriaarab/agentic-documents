import { checkAuthor, DocError, type AgenticDoc, type AnchorTarget, type Principal, type TextTarget } from "./doc.js";
import { Suggestions } from "./review.js";

/** A replacement, deletion (empty replacement), or insertion (target.at). */
export interface AssistantProposal {
  target: TextTarget | AnchorTarget;
  replacement: string;
}

/** Give this port to an assistant adapter. It has no decision or direct edit method. */
export interface AssistantSuggestions {
  propose(proposal: AssistantProposal): string;
}

/** Bind proposals to one machine principal. The host owns persistence and provider calls. */
export function createAssistantSuggestions(doc: AgenticDoc, author: Principal): AssistantSuggestions {
  const checked = checkAuthor(author);
  if (checked.kind === "human") throw new DocError("INVALID_AUTHOR", "an assistant needs a machine principal");
  const who = { ...checked, scopes: checked.scopes ? [...checked.scopes] : undefined };
  const suggestions = new Suggestions(doc);
  return Object.freeze({ propose: ({ target, replacement }: AssistantProposal) => suggestions.add(target, replacement, who) });
}
