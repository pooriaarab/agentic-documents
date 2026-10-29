# agentic-documents

[![npm version](https://img.shields.io/npm/v/agentic-documents)](https://www.npmjs.com/package/agentic-documents)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-documents) · [Source](https://github.com/pooriaarab/agentic-documents) · [Support](https://github.com/pooriaarab/agentic-documents/issues)

Write documents with people and agents in real time.

> Status: early. The document model and the text operations work in Node. The
> package is not on npm yet. The web UI is not built yet.

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
npx agentic-documents export plan --format odt --out plan.odt   # OpenDocument text
```

Run `npx agentic-documents --help` for every command.

## MCP

`npx agentic-documents mcp --as agent_of_human:claude` starts a stdio server. It has one tool
per command, named `doc_<command>` (`doc_read`, `doc_replace`, `doc_suggest`, and so on). The
author is fixed when the server starts. A tool call cannot pick another author.

## HTTP API

A Cloudflare Worker (Hono) mirrors the CLI one to one under `/api/v1/docs`. A read command is a
`GET` (flags are query parameters). A write command is a `POST` (flags are the JSON body).

```sh
curl -X POST $URL/api/v1/docs -H "authorization: Bearer $TOKEN" -d '{"id":"plan","markdown":"# Plan"}'
curl "$URL/api/v1/docs/plan/outline" -H "authorization: Bearer $TOKEN"
curl -X POST $URL/api/v1/docs/plan/replace -H "authorization: Bearer $TOKEN" -d '{"text":"Plan","content":"Roadmap"}'
curl "$URL/api/v1/docs/plan/export?format=html" -H "authorization: Bearer $TOKEN"
# add &remoteImages=true to keep web images; the default shows only images stored inside the document
```

- Each token stands for one author. Set `AGENTIC_DOCS_TOKENS` as a secret:
  `wrangler secret put AGENTIC_DOCS_TOKENS`. The value is a JSON object from token to author:
  `{"<32 or more random bytes>":"agent_of_human:scribe"}`. To give an agent the right to accept
  suggestions, use `{"as":"agent_of_human:approver","scopes":["docs:accept"]}` as the value.
  Make a token with `openssl rand -hex 32`.
- A token under 32 bytes, a value that is not a valid author, or a value that is not a JSON
  object makes the Worker refuse every request (401). It logs the reason once, never the token.
  A body cannot name its own author. With no tokens the API refuses every request.
- Errors are `{ "error": { "code", "message", "matches" } }`. Status: 400 bad input, 401 no
  valid token, 403 `FORBIDDEN` (for example an agent without `docs:accept` that accepts), 404 not
  found, 409 a conflict (ambiguous match, stale anchor, already decided), 503 `LOCKED`.
- `GET /health` needs no token. It reveals nothing else.
- Create an R2 bucket with `wrangler r2 bucket create agentic-documents-data --jurisdiction eu` and a D1
  database with `wrangler d1 create agentic-documents --jurisdiction eu`. Put the database id in
  `wrangler.jsonc`. Set `AGENTIC_DOCS_REGION` to `eu` or `us`. It is a claim that you make: it has no
  default, and the Worker answers 500 `MISCONFIGURED` without it. Local D1 reports no region, so under
  `wrangler dev` only, add `--var AGENTIC_DOCS_REGION:unknown --var AGENTIC_DOCS_UNSAFE_REGION:1`. That turns the
  residency check off.
- Run it locally with `npx wrangler dev`. Set `WRANGLER_SEND_METRICS=false` to turn off wrangler telemetry.

## Features

- A Yjs document that a Tiptap editor can open. It uses the y-prosemirror layout.
- Headings, paragraphs, lists, task lists, tables, code, images, links, and marks.
- Markdown in and out.
- An outline. Each section has an id that stays the same when people edit around it. Blocks before the
  first heading are the `preamble` section (level 0). It is listed when they exist, and it is always a
  valid target. A replace or delete on it has no heading to keep.
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
- Export to ODT (OpenDocument text): headings, paragraphs, bold, italic, strike, code, links, lists,
  quotes, rules, tables, and images as embedded files. The package follows ODF 1.3 with the mimetype
  stored first. The CLI and the API send the file bytes. LibreOffice opens it, lists keep their
  numbers, and its own re-save reads back to the same Markdown (checked by hand with LibreOffice 24.8
  in the PR that added it).
- Export to Markdown and to self-contained HTML. The HTML loads nothing from other hosts. An image
  stored in the document as a `data:` URI (PNG, JPEG, GIF, or WebP) shows. Any other image becomes
  its alt text, because a remote image tells its host who opened the file. `remoteImages` turns
  that back on.
- Every edit, message, and suggestion needs an author. The edit log keeps the kind and the name, so
  agent work stays labeled. The log holds no content. Over the CLI, MCP, and HTTP the server or
  the operator sets the author. In a live room a client writes its own log entries, so treat the log
  there as advisory. The room's own record of who sent updates is at `GET /api/v1/docs/:id/room`.

## Rules for text matching

- A match is exact and case sensitive.
- A match stays inside one block. It cannot cross a paragraph, a cell, or a hard break.
- More than one match is an error, and matches may overlap: `ana` matches twice in `banana`. Pass `occurrence` (1 is the first start) to choose.
- A replacement takes the marks of the first matched character.

## Limits

- No web UI yet.
- The Worker keeps each document in R2 and a catalog (who made it, and when) in D1. Both come from the
  shared `agentic-identity` ports. A save is conditional on the version it read, so two writers cannot
  overwrite each other. The CLI and MCP server keep the same data in local files.
- The CLI and MCP server keep files under `<dir>/blobs` and `<dir>/store`. Files from an older release that sit
  directly in `<dir>` are not read.
- Token auth is a stopgap until the `Auth` port exists. A token has one role for the whole server: `editor` (the default) or `viewer`. A viewer cannot call a write command or write in a live room. There is no per-document sharing yet.
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
- Export covers Markdown, HTML, and ODT. DOCX export, and ODT and DOCX import, are planned.
- ODT export: comments and suggestions are not written. A code block loses its language. A table
  cell span is not written (the model has none yet). A task list becomes a bullet list that starts each
  item with `☐` or `☑`. A remote image is not linked, because an office program would ask its host
  for it when the file opens. It becomes its alt text.
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
