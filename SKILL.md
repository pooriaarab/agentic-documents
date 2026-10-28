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

## Rules

- Pass your author kind and name on every change.
- Read the outline, then the section, before you edit.
- On an ambiguous match, pass `occurrence`.
- Report errors as failures.
