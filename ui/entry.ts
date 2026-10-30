// The `agentic-documents/ui` entry: `mount` for the whole app, and `mountEditor` for one editor.
export * from "./embed.js";
export { mount, type Mounted, type MountOptions } from "./mount.js";
export { ReviewPanel, CommentAnchor, type ReviewPanelOptions } from "./review.js";
// Browser hosts can construct the engine without loading the root's Node adapters.
export { AgenticDoc, type Anchor, type Principal } from "../src/doc.js";
export { createAssistantSuggestions, type AssistantProposal, type AssistantSuggestions } from "../src/assistant.js";
