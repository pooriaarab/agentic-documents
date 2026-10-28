# agentic-documents

[![npm version](https://img.shields.io/npm/v/agentic-documents)](https://www.npmjs.com/package/agentic-documents)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-documents) · [Source](https://github.com/pooriaarab/agentic-documents) · [Support](https://github.com/pooriaarab/agentic-documents/issues)

Write documents with people and agents in real time.

> Status: early. The document model and the text operations work in Node. The
> package is not on npm yet. The CLI, the MCP server, the HTTP API, comments,
> suggestions, and the web UI are not built yet.

## Install

```sh
npm install agentic-documents
```

## Quick start

```ts
import { AgenticDoc } from "agentic-documents";

const agent = { kind: "agent_of_human", name: "scribe" } as const;

const doc = AgenticDoc.fromMarkdown("# Plan\n\nShip on Friday.", agent);
const [plan] = doc.outline();

doc.replace({ text: "Friday" }, "Monday", agent);
doc.insert({ section: plan.id, at: "end" }, "- [ ] Write notes", agent);

console.log(doc.toMarkdown());
console.log(doc.edits()); // each edit keeps the author kind and name
```

## Features

- A Yjs document that a Tiptap editor can open. It uses the y-prosemirror layout.
- Headings, paragraphs, lists, task lists, tables, code, images, links, and marks.
- Markdown in and out.
- An outline. Each section has an id that stays the same when people edit around it.
- Insert, replace, and delete by section id or by exact text. Append to the end.
- Text anchors that follow their text when other replicas edit.
- Clear errors: `NO_MATCH`, `AMBIGUOUS_MATCH`, `STALE_ANCHOR`, `NO_SECTION`.
- Every edit needs an author. The edit log keeps the kind and the name, so
  agent work stays labeled. The log holds no content.

## Rules for text matching

- A match is exact and case sensitive.
- A match stays inside one block. It cannot cross a paragraph, a cell, or a hard break.
- More than one match is an error. Pass `occurrence` (1 is the first) to choose.
- A replacement takes the marks of the first matched character.

## Limits

- No CLI, MCP server, HTTP API, or web UI yet.
- No comments or suggested edits yet.
- Export covers Markdown only. HTML, DOCX, and ODT (.odt) exports are planned.
- Text before the first heading has no section id. Use `append` or a text match.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
