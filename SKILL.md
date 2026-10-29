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

## Use the CLI or MCP

```sh
agentic-documents outline plan --as agent_of_human:scribe
agentic-documents mcp --as agent_of_human:scribe
```

Tools are named `doc_<command>`: `doc_read`, `doc_outline`, `doc_replace`, `doc_suggest`, `doc_grant`.

## Use the library exports

- `commands` is the command table that the CLI, MCP, and HTTP API read. Each command runs over a `new DocsService({ blobs, store })`, built from `createFileBlobs(dir)` and `createFileStore(dir)`.
- `exportDoc(doc, "md" | "html" | "odt")` returns `{ encoding, data, warnings }`. `exportOdt(blocks)` returns the bytes of an `.odt` file.
- `Threads` holds comments. `Suggestions` holds suggested edits. Nobody accepts their own suggestion.
- The README section "Library API" lists every root export with an example.

## Rules

- Pass your author kind and name on every change.
- Share only a document that you own, and only when asked. `grant`, `revoke`, `invite`, and `link` need an owner, and every caller needs the `docs:admin` scope over HTTP (an agent needs it in the CLI and MCP too). On `FORBIDDEN`, stop. Never grant yourself a role.
- Read the outline, then the section, before you edit.
- On an ambiguous match, pass `occurrence`.
- Report errors as failures.
