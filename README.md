# agentic-documents

[![npm version](https://img.shields.io/npm/v/agentic-documents)](https://www.npmjs.com/package/agentic-documents)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-documents) · [Source](https://github.com/pooriaarab/agentic-documents) · [Support](https://github.com/pooriaarab/agentic-documents/issues)

Write documents with people and agents in real time.

> Status: early. The document model and the text operations work in Node. The
> package is not on npm yet. The HTTP API and the web UI are not built yet.

## Install

```sh
npm install agentic-documents
```

## Quick start

```ts
import { AgenticDoc, Suggestions, Threads } from "agentic-documents";

const agent = { kind: "agent_of_human", name: "scribe" } as const;

const doc = AgenticDoc.fromMarkdown("# Plan\n\nShip on Friday.", agent);
const [plan] = doc.outline();

doc.replace({ text: "Friday" }, "Monday", agent);
doc.insert({ section: plan.id, at: "end" }, "- [ ] Write notes", agent);

console.log(doc.toMarkdown());
console.log(doc.edits()); // each edit keeps the author kind and name

const person = { kind: "human", name: "Ada" } as const;
const suggestions = new Suggestions(doc);
const id = suggestions.add({ text: "Monday" }, "Tuesday", agent);
suggestions.accept(id, person); // the text changes now
new Threads(doc).add({ text: "Tuesday" }, "Is this date firm?", agent);
```

## CLI

Every change needs an author: `--as <kind>:<name>` or `AGENTIC_DOCS_AS`. An agent that may accept
suggestions also needs `--scopes docs:accept` (or `AGENTIC_DOCS_SCOPES`). Documents live in
`--dir` (or `AGENTIC_DOCS_DIR`, default `.agentic-documents`) as Yjs update files.

```sh
export AGENTIC_DOCS_AS=agent_of_human:scribe
npx agentic-documents new plan --markdown "# Plan\n\nShip on Friday."
npx agentic-documents outline plan
npx agentic-documents replace plan --text Friday --content Monday
npx agentic-documents suggest plan --text Monday --replacement Tuesday
npx agentic-documents comment plan --text Tuesday --body "Is this date firm?"
npx agentic-documents export plan --format md --out plan.md
```

Run `npx agentic-documents --help` for every command.

## MCP

`npx agentic-documents mcp --as agent_of_human:claude` starts a stdio server. It has one tool
per command, named `doc_<command>` (`doc_read`, `doc_replace`, `doc_suggest`, and so on). The
author is fixed when the server starts. A tool call cannot pick another author.

## Features

- A Yjs document that a Tiptap editor can open. It uses the y-prosemirror layout.
- Headings, paragraphs, lists, task lists, tables, code, images, links, and marks.
- Markdown in and out.
- An outline. Each section has an id that stays the same when people edit around it.
- Insert, replace, and delete by section id or by exact text. Append to the end.
- Text anchors that follow their text when other replicas edit.
- Clear errors: `NO_MATCH`, `AMBIGUOUS_MATCH`, `STALE_ANCHOR`, `NO_SECTION`, `FORBIDDEN`.
- Comment threads on text, with replies and resolve. A thread follows its text.
- Suggested edits (insert, replace, delete). Nothing changes until a person accepts.
  An accepted edit is logged with the accepter as editor and the suggester as origin.
- Who may decide: a `human` or a `user_token` who is not the suggester. An agent cannot accept
  unless its principal carries the `docs:accept` scope. Nobody accepts their own suggestion.
  A person can withdraw their own suggestion. An agent can never accept or reject its own. Other
  deciders get `FORBIDDEN`. Accepting an accepted
  suggestion changes nothing. Editor roles come with `agentic-identity`.
- Two replicas can accept one suggestion before they meet. After the merge every replica keeps
  one application and undoes the other, so the text and the edit log hold it once. An accept
  beats a reject made at the same moment.
- Export to Markdown.
- Every edit, message, and suggestion needs an author. The edit log keeps the kind and the name, so
  agent work stays labeled. The log holds no content.

## Rules for text matching

- A match is exact and case sensitive.
- A match stays inside one block. It cannot cross a paragraph, a cell, or a hard break.
- More than one match is an error, and matches may overlap: `ana` matches twice in `banana`. Pass `occurrence` (1 is the first start) to choose.
- A replacement takes the marks of the first matched character.

## Limits

- No HTTP API or web UI yet.
- A save is a compare-and-set. The file store takes a lock file, checks the version, and renames a
  uniquely named temp file into place. A writer that loses loads the document again and runs
  its change again. A lock older than 10 seconds counts as dead and is taken over. A lock that
  cannot be read, or that is dated in the future, counts as live. A writer that waits more than
  5 seconds fails with `LOCKED`. A writer that loses 64 times in a row fails with `CONFLICT`. The lock
  is for one machine. Two machines on a network file system need a store with its own
  conditional write.
- `--as` and `AGENTIC_DOCS_AS` are self-declared labels. The CLI does not prove who runs it, so
  `--as human:Ada` labels work as human on any machine that can run the command. Only the HTTP API
  (tokens) and an MCP server that a trusted host starts fix the author for the caller.
- Suggestions work on text, not on whole sections.
- A scope on a principal is trusted as given. Nothing here proves who a caller is.
- Export covers Markdown only. HTML, DOCX, and ODT (.odt) exports, and ODT import, are planned.
- Text before the first heading has no section id. Use `append` or a text match.
- Markdown with footnotes, or any syntax the model has no place for, is refused with
  `INVALID_INPUT`. Nothing is stored. Reference links and image references are resolved to
  their URL. An unused reference definition is dropped.
- Markdown import drops link titles, table column alignment, and the part of a code fence
  line after the language.
- Markdown output trims whitespace at the edge of a block and skips empty paragraphs. A text
  target that includes a trailing space can match in the document and not in `read` output.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
