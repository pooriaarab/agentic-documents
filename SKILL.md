---
name: agentic-documents
description: Read and edit rich-text documents by section or exact text, as Markdown, with every edit labeled by author. Keywords: documents,editor,rich-text,tiptap,yjs,agents.
---

# agentic-documents

Write documents with people and agents in real time.

## Use the SDK

```ts
import { AgenticDoc } from "agentic-documents";

const me = { kind: "agent_of_human", name: "scribe" } as const;
const doc = AgenticDoc.fromMarkdown("# Plan\n\nShip on Friday.", me);
doc.replace({ text: "Friday" }, "Monday", me);
doc.toMarkdown();
```

Other root exports:

- `Suggestions` and `Threads` add proposed edits and comments to an `AgenticDoc`.
- `markdownToBlocks`, `blocksToMarkdown`, and `schema` map and check ProseMirror JSON blocks.
- `exportDoc` writes `md`, `html`, or base64 `odt`; `exportOdt` writes raw ODT bytes from blocks.
- `DocsService`, `createFileStore`, and `createFileBlobs` make a local store-backed service.
- `commands` is the shared command table for CLI, MCP, and HTTP.
- `contextOf`, `parseSubject`, and `StoreSharing` support sharing helpers.

Subpaths:

- `agentic-documents/client` has the typed HTTP client.
- `agentic-documents/formats` imports and exports Markdown, HTML, ODT, and DOCX.
- `agentic-documents/live` has `LiveDoc` for live rooms.
- `agentic-documents/worker` and `agentic-documents/live-worker` are Worker entry points.
- `agentic-documents/ui`, `agentic-documents/ui.css`, and `agentic-documents/app.css` embed the editor or app.

## Use the CLI or MCP

```sh
agentic-documents outline plan --as agent_of_human:scribe
agentic-documents mcp --as agent_of_human:scribe
```

Tools are named `doc_<command>`: `doc_read`, `doc_outline`, `doc_replace`, `doc_suggest`, `doc_grant`.

## Rules

- Pass your author kind and name on every change.
- Share only a document that you own, and only when asked. `grant`, `revoke`, `invite`, and `link` need an owner, and every caller needs the `docs:admin` scope over HTTP (an agent needs it in the CLI and MCP too). On `FORBIDDEN`, stop. Never grant yourself a role.
- Read the outline, then the section, before you edit.
- On an ambiguous match, pass `occurrence`.
- Report errors as failures.
