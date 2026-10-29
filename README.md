# agentic-documents

[![npm version](https://img.shields.io/npm/v/agentic-documents)](https://www.npmjs.com/package/agentic-documents)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-documents) · [Source](https://github.com/pooriaarab/agentic-documents) · [Support](https://github.com/pooriaarab/agentic-documents/issues)

Write documents with people and agents in real time.

> Status: early, version 0.7.0. The document model, the text operations, the CLI, the MCP server,
> the Worker API, live editing in a room, and a small web UI work. See [UI](#ui).

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

## UI

The Worker serves a small web app, built on [agentic-design](https://www.npmjs.com/package/agentic-design)
and the typed client (`agentic-documents/client`). It has a document list, a rich-text editor (headings,
lists, bold, italic, links), rename, delete, a share dialog, the people and agents in the room, and a dotted
underline on text that an agent wrote. The tests check each main view with axe (WCAG 2.2 AA rules) in the light and the dark theme: sign in, list, empty and error list, new-document dialog, editor, share dialog, link, rename and delete dialogs, the actions menu, and the read-only view. Axe finds only part of the faults, so it does not replace a test with a screen reader. Screenshots of
every view are in [docs/screenshots](docs/screenshots).

Run it on your machine:

```sh
npm ci
npm run build                      # writes dist/ and dist/ui
export WRANGLER_SEND_METRICS=false
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
npx wrangler dev --var AGENTIC_DOCS_REGION:unknown --var AGENTIC_DOCS_UNSAFE_REGION:1 \
  --var "AGENTIC_DOCS_TOKENS:{\"$TOKEN\":\"human:Ada\"}"
```

Open the address that wrangler prints, paste the token, and sign in. The token stays in that tab and goes
when you close it. A token for an agent, such as `agent_of_human:Scribe`, makes its edits show as agent text.
A `viewer` token opens documents read only. The region setting turns the residency check off, so use it for
local work only.

How it works:

- The list, rename, delete, and the share dialog use the HTTP API through the typed client.
- The editor joins the live room of the document. A browser WebSocket cannot send an `Authorization`
  header, so the page offers the token as a subprotocol, which only the live-room route reads.
- The page saves the room to the stored document 1.5 seconds after a change, and when you leave the
  document in the app (not when you close the tab). A command over HTTP then reads the new text. A save never makes a document: if someone deleted it, the page says so, stops saving, and turns read only.
- An agent's text is the text whose writer is a logged edit by a non-human author (see the `client` field of the
  edit log). Typing in the editor does not add to the edit log.
- The page sets a content security policy: scripts, styles, fonts, and images come from the Worker only, and a document image that points to another host does not load.
- Run the tests with `npm run e2e`. They start `wrangler dev` with the built UI, drive Chromium with
  Playwright, and run an axe check (WCAG 2.2 AA) on each view in both themes. Run them once with
  `UPDATE_SCREENSHOTS=1` to write the screenshots again.

### Serve the UI from the npm package

The npm package ships the built UI in `dist/ui`. You do not need a clone to serve it. Install the package in
your Worker project and point your `wrangler.jsonc` at the files in it:

```sh
npm install agentic-documents
```

```jsonc
{
  "name": "my-docs",
  "main": "node_modules/agentic-documents/dist/live-worker.js",
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "node_modules/agentic-documents/dist/ui" },
  "durable_objects": { "bindings": [{ "name": "SYNC_ROOM", "class_name": "SyncRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SyncRoom"] }]
}
```

Add the D1 and R2 bindings from the sample `wrangler.jsonc`, and set `AGENTIC_DOCS_TOKENS` as a secret.
The Worker serves the files in `dist/ui` first. It answers `/api`, `/health`, and any other path. If you deploy from a clone
with the sample `wrangler.jsonc`, run `npm run build` before `wrangler deploy`. The build writes `dist/ui`,
and the sample file reads it.

## CLI

Every change needs an author: `--as <kind>:<name>` or `AGENTIC_DOCS_AS`. An agent that may accept
suggestions also needs `--scopes docs:accept` (or `AGENTIC_DOCS_SCOPES`). Documents live in
`--dir` (or `AGENTIC_DOCS_DIR`, default `.agentic-documents`) as Yjs update files.

```sh
export AGENTIC_DOCS_AS=agent_of_human:scribe
printf '# Plan\n\nShip on Friday.\n' > plan.md
npx agentic-documents new plan --file plan.md
npx agentic-documents outline plan
npx agentic-documents replace plan --text Friday --content Monday
npx agentic-documents suggest plan --text Monday --replacement Tuesday
npx agentic-documents comment plan --text Monday --body "Is this date firm?"
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
curl "$URL/api/v1/docs" -H "authorization: Bearer $TOKEN"   # list: id, title, creator, last edit
curl -X POST $URL/api/v1/docs/plan/rename -H "authorization: Bearer $TOKEN" -d '{"title":"Roadmap"}'
curl "$URL/api/v1/docs/plan/export?format=html" -H "authorization: Bearer $TOKEN"
# add &remoteImages=true to keep web images; the default shows only images stored inside the document
```

- Each token stands for one author. Set `AGENTIC_DOCS_TOKENS` as a secret:
  `wrangler secret put AGENTIC_DOCS_TOKENS`. The value is a JSON object from token to author:
  `{"<32 or more random bytes>":"agent_of_human:scribe"}`. To give an agent the right to accept
  suggestions, use `{"as":"agent_of_human:approver","scopes":["docs:accept"]}` as the value.
  Make a token with `openssl rand -hex 32`. A token holds only `A-Z a-z 0-9 _ -` (32 to 512 bytes), and an
  author name holds only `A-Z a-z 0-9 . _ -` (up to 128 characters, no space or `@`).
- A token under 32 bytes, a token with other characters (for example base64 with `+` or `/`), a value that is not a valid author, or a value that is not a JSON
  object makes the Worker refuse every request (401). It logs the reason once, never the token.
  A body cannot name its own author. With no tokens the API refuses every request.
- Errors are `{ "error": { "code", "message", "matches" } }`. Status: 400 bad input, 401 no
  valid token, 403 `FORBIDDEN` (for example an agent without `docs:accept` that accepts), 404 not
  found, 409 a conflict (ambiguous match, stale anchor, already decided), 503 `LOCKED`.
- `list` shows each document's title, creator kind, and last edit. `rename` sets the title and keeps the text.
  `remove` deletes the whole document. A person may remove. An agent needs the `docs:remove` scope, for example
  `{"as":"agent_of_human:sweeper","scopes":["docs:remove"]}`. A live room keeps its own copy of the text after `remove`, so
  an open client can bring the document back with a save.
- A browser cannot send an `Authorization` header on a WebSocket. It offers two subprotocols instead:
  `agentic-docs` and `agentic-docs.bearer.<token in base64url>`. Only the live-room route reads it, and the server
  answers with `agentic-docs`, never the token. A header value can show in the logs of a proxy or a host, so
  keep access logs of that header off.
- Each edit log entry holds `client`, the Yjs client id of the replica that wrote it. A UI uses it to mark text
  an agent wrote. A client writes it, like the rest of the log.
- `GET /health` needs no token. It reveals nothing else.
- Create an R2 bucket with `wrangler r2 bucket create agentic-documents-data --jurisdiction eu` and a D1
  database with `wrangler d1 create agentic-documents --jurisdiction eu`. Put the database id in
  `wrangler.jsonc`. Set `AGENTIC_DOCS_REGION` to `eu` or `us`. It is a claim that you make: it has no
  default, and the Worker answers 500 `MISCONFIGURED` without it. Local D1 reports no region, so under
  `wrangler dev` only, add `--var AGENTIC_DOCS_REGION:unknown --var AGENTIC_DOCS_UNSAFE_REGION:1`. That turns the
  residency check off.
- Run it locally with `npx wrangler dev`. Set `WRANGLER_SEND_METRICS=false` to turn off wrangler telemetry.

## SDK

`agentic-documents/client` is a typed client for the Worker HTTP API. It uses only `fetch`, so it runs in
browsers, Workers, and Node 22. The token sets the author and the role.

```ts
import { createClient, DocsApiError } from "agentic-documents/client";

const docs = createClient({ baseUrl: "https://docs.example.com", token: process.env.AGENTIC_DOCS_TOKEN! });
await docs.create({ id: "plan", markdown: "# Plan" });
const [section] = await docs.outline("plan");
await docs.replace("plan", { section: section.id, content: "Ship it." });
console.log(await docs.read("plan"));

try {
  await docs.read("missing", {}, { signal: AbortSignal.timeout(5000) });
} catch (error) {
  if (error instanceof DocsApiError) console.log(error.code, error.status); // NO_DOCUMENT 404
}
```

- One method per route: `create`, `list`, `read`, `rename`, `remove`, `outline`, `edits`, `insert`, `replace`, `delete`, `append`,
  `suggest`, `suggestions`, `accept`, `reject`, `comment`, `reply`, `resolve`, `reopen`, `threads`,
  `export`, `room`, `me`, `health`, `state`, and `checkpoint`. The WebSocket route is not a method. Use
  `LiveDoc` from `agentic-documents/live` for it.
- Every method takes an optional `{ signal }` last. An abort rejects with what `fetch` throws.
- An API error throws `DocsApiError` with `code` (the API error code), `status` (the HTTP status), and
  `matches`. A reply that is not an API error has the code `HTTP_ERROR`. A 2xx reply with the wrong content type or shape has the code `BAD_RESPONSE`.
- The client never retries. A write is not safe to send twice.
- Pass `fetch` to use your own, for a Worker service binding or for tests.

## Embed the editor

`agentic-documents/ui` renders the editor inside your own app. You give it a document id, a client, the principal who
uses it, and an optional live room. With a room, people and agents edit together through agentic-realtime and see each
other. It needs `react` and `react-dom` 19 (peer dependencies).

```ts
import { createClient } from "agentic-documents/client";
import { mountEditor } from "agentic-documents/ui";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";

const client = createClient({ baseUrl: "https://docs.example.com", token });
const principal = await client.me(); // { kind, name, role }
const editor = mountEditor(document.getElementById("editor")!, {
  id: "plan",
  client,
  principal,
  room: { url: "wss://docs.example.com/api/v1/docs/plan/ws", token },
});
// Later: editor.update({ ...options, id: "other" }), or await editor.unmount() to save this tab's changes and leave.
```

- In a React app, render `<DocumentEditor id client principal room onError onLeave />` instead. `onLeave` gets the
  promise of the last save.
- `client` needs only `state` and `checkpoint`. A client from `createClient` has them, or pass your own. Keep the
  same client object between renders: a new one opens the document again.
- `principal` needs a `kind` (one of the principal kinds) and a `name`. A missing or unknown kind throws a
  `TypeError`. It is never given a default. Only the `role` `editor` can change the text. Any other role, or no role,
  opens it read only. The server still checks every write against the token. Use the principal that `client.me()`
  returns for the same token, so the editor labels the text with the kind that the server gives the token.
- When an agent principal types, the editor writes one `live` entry to the edit log for its Yjs client. The editor
  and the web UI then mark that text as agent work for everyone who opens the document.
- `room.url` is the WebSocket address of the document room. In a browser the token goes in a WebSocket subprotocol.
  Pass `room.WebSocket` for a room that takes its token another way. Without a room, the editor saves through the
  client and shows no other people.
- The editor saves 1.5 seconds after this tab changes the text, and again on `unmount`. The promise from `unmount`
  rejects when that last save fails. A save never makes a document, so a removed document stays removed.
- The styles sit under the `.adoc` class and use the agentic-design tokens. Load `agentic-design/styles.css` first.
- File import and export are in `agentic-documents/formats` (see [File formats](#file-formats)).

## Mount the whole app

`mount(element, options)` of `agentic-documents/ui` renders the whole web UI inside your page: the document list, the
editor, rename, delete, and share. You give it a base URL and a callback that returns the token. Your page keeps
sign in and its own address. It needs `react` and `react-dom` 19 (peer dependencies).

```ts
import { mount } from "agentic-documents/ui";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";
import "agentic-documents/app.css";

const app = mount(document.getElementById("app")!, {
  baseUrl: "https://docs.example.com",
  getToken: () => session.token(), // a string, or a promise of one
  documentId: "plan", // optional: open this document first
  onError: (error) => console.warn(error),
});
// Later: app.update({ ...options, documentId: "other" }), or app.unmount().
```

- `getToken` runs when the app opens, and again when the person picks Try again on the sign-in error. The app does not
  ask again when a token expires later: call `app.update({ ...options, getToken: newFunction })` to sign in with a new
  token. `onError` is called when sign in fails. The server sets the author and the role from the token. The app shows
  no Sign out button.
- A link in the app moves inside the app. It does not change the address of your page.
- `baseUrl` must be a full `http` or `https` address with no query, fragment, or credentials. It may have a path, such as
  `https://example.com/docs`.
- The theme picker uses the agentic-design theme. It sets `data-theme` on the page and saves the choice in local
  storage, so it changes the whole host page.
- `unmount` removes the app. An open document saves its changes and leaves its room.
- `app.css` holds the layout rules of the app. They use plain class names such as `.page-head` and `.muted`, so load
  them on a page that has its own styles with care. To embed one document only, use `mountEditor` above.

## File formats

`agentic-documents/formats` imports and exports files, so an app that embeds the editor needs no mapping
code of its own. ODT and DOCX go through the neutral text model of
[agentic-formats](https://github.com/pooriaarab/agentic-formats). Markdown and HTML use the mapping of this package.

```ts
import { exportFile, importFile } from "agentic-documents/formats";

const { doc, title, warnings } = importFile(bytes, "docx", { kind: "human", name: "Ada" });
const odt = exportFile(doc, "odt", { title }); // { contentType, data (Uint8Array for odt), warnings }
```

- `importFile(input, format, author, { limits? })` reads `md` (text or UTF-8 bytes), `odt`, or `docx` (bytes) into a
  new `AgenticDoc`. The author makes the one `create` edit, so a file that an agent imports stays labeled as agent work.
- `exportFile(doc, format, { title?, remoteImages? })` writes `md` or `html` (text), or `odt` or `docx` (bytes).
- Each result has `warnings`: one line for each kind of content that the other side cannot hold. The text of that
  content stays.
- A file that is not valid, or that goes past a limit in `limits` (the agentic-formats defaults), fails with
  `INVALID_INPUT`. For `md`, only `maxInputBytes` applies. A link that is not a web, mail, or relative address is dropped, and its text stays.
- `toTextDoc(blocks)` and `fromTextDoc(model)` are the mapping itself, for an app that works with the model.

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
  tables, and PNG, JPEG, and GIF images as embedded files. `agentic-formats` writes the file, with the
  mimetype stored first. The CLI and the API send the file bytes. A quote, a code block, a rule, a list
  start number, and a WebP image are not kept in full (see Limits). Each loss is in `warnings` (SDK and
  MCP), on stderr (CLI), and in the `x-export-warnings` header (API).
- Export to Markdown and to self-contained HTML. The HTML loads nothing from other hosts. An image
  stored in the document as a `data:` URI (PNG, JPEG, GIF, or WebP) shows. Any other image becomes
  its alt text, because a remote image tells its host who opened the file. `remoteImages` turns
  that back on.
- Every edit, message, and suggestion needs an author. The edit log keeps the kind and the name, so
  agent work stays labeled. The log holds no content. Over the CLI, MCP, and HTTP the server or
  the operator sets the author. In a live room a client writes its own log entries, suggestion decisions, and
  threads. A save merges them into the stored document. So after a live client saves, treat all three
  as advisory. The room's own record of who sent updates in the room is at `GET /api/v1/docs/:id/room`. It does not cover
  text written over HTTP, the CLI, or MCP before the room opened: the client that seeds the room appears there.

## Live demo

A demo Worker runs at <https://agentic-documents-demo.hello-fd1.workers.dev>. It is a staging build. Open the
address to see the web UI. `GET /health` answers 200 with no token. The UI asks for a token and the API refuses calls without one. The demo does
not publish a token, so run your own Worker to try edits (see [Live editing](#live-editing)). The demo may be reset at any
time.

The demo uses `wrangler.demo.jsonc`: a D1 database and an R2 bucket with the `eu` jurisdiction, live rooms in
Durable Objects, and `AGENTIC_DOCS_REGION=eu`. To redeploy, a maintainer with a Cloudflare token runs:

```sh
CLOUDFLARE_API_TOKEN=<token> npm run deploy:demo
```

The tokens live in a Worker secret, never in the repo or in CI. Set them with
`WRANGLER_SEND_METRICS=false npx wrangler secret put AGENTIC_DOCS_TOKENS --config wrangler.demo.jsonc`. To make your own demo, copy
`wrangler.demo.jsonc`, change the name, and put your own database id and bucket name in it. Make the database with
`WRANGLER_SEND_METRICS=false npx wrangler d1 create <name> --jurisdiction eu`, because the jurisdiction is fixed when you create it. Make the bucket with
`WRANGLER_SEND_METRICS=false npx wrangler r2 bucket create <name> --jurisdiction eu`.

## Live editing

A person and an agent can edit one document at the same time. Each sees the other's changes. The Worker
hosts one room per document, on a Durable Object, through [agentic-realtime](https://www.npmjs.com/package/agentic-realtime).
Deploy `agentic-documents/live-worker`. The sample `wrangler.jsonc` binds `SYNC_ROOM` and sets the migration.

```ts
import { LiveDoc } from "agentic-documents/live";

const live = await LiveDoc.join({ server: "https://docs.example.com", id: "plan", token });
await live.edit((doc, author) => doc.append("Ship on Friday.", author));
console.log(live.peers); // the other people and agents. `machine` is true for an agent.
await live.save(); // write the room state to the stored document
await live.leave();
```

The CLI and the MCP server join rooms too. Every command then runs in the room and saves:

```sh
export AGENTIC_DOCS_TOKEN=...   # a bearer token. The server sets the author kind and the role.
export AGENTIC_DOCS_LIVE_URL=https://docs.example.com   # or pass --live <url>
npx agentic-documents append plan --content "Ship on Friday." --live https://docs.example.com
npx agentic-documents mcp --live https://docs.example.com
```

- The server reads your author kind and role from the token (`GET /api/v1/me`). An agent token writes
  agent edits. `--as`, `--scopes`, and `--dir` do not apply with `--live`: the CLI refuses them and exits 2. This
  holds when `AGENTIC_DOCS_LIVE_URL` is set too, so unset it for a local call.
- A room starts from the stored document. `save` merges the room back into the stored document, so
  `read`, `export`, and the other commands see live edits. A save also creates a document that has none.
  The CLI and MCP server save after each change. If a save fails, the room keeps the change and the error says so: do not repeat it. `new` makes the document in the store, and a room picks it up on the next join. A document over 1,000,000 bytes cannot open in a room or be saved from one. A save refuses an update with a wrong
  kind of content or a malformed thread, suggestion, or log entry. HTTP edits reach an open room only when a client joins and seeds it.
- A `viewer` token joins and reads. The room drops its updates, and `edit` and `save` fail with `FORBIDDEN`.
  Set a role in `AGENTIC_DOCS_TOKENS` with `{ "as": "human:Vic", "role": "viewer" }`. A token with no role is an editor.
- `GET /api/v1/docs/:id/room` lists who sent updates in the room, and whether each is machine-made.
- Pass `reconnect: {}` to `join` to keep trying after a drop. Edits made offline merge on return.
  A room that restarts recovers its state from the Durable Object.

Limits of live editing:

- The edit log, the suggestion decisions, and the threads live in the document, and a client writes them.
  A modified client can write a log entry with another author, or accept its own suggestion. The room's
  list at `/room` is the record to trust for who sent updates. It does not cover text written before the
  room opened.
- Until a client saves, a command over HTTP reads the stored copy, not the room.
- After the room refuses an edit, the local copy of `LiveDoc` still holds it. Join again.
- Durable Objects have no US jurisdiction. With the region `us` a room sits near the first client that opens it.
  With `eu` it stays in the EU. The local `wrangler dev` cannot place rooms.

## Rules for text matching

- A match is exact and case sensitive.
- A match stays inside one block. It cannot cross a paragraph, a cell, or a hard break.
- More than one match is an error, and matches may overlap: `ana` matches twice in `banana`. Pass `occurrence` (1 is the first start) to choose.
- A replacement takes the marks of the first matched character.

## Limits

- The UI has no accounts. You paste a token, and the token sets your role. The share dialog shows a link and who
  changed the document. Roles, invites, and expiring links wait for the sharing API in the Worker.
- The UI marks agent text from the edit log, which a client writes. A modified client can mark its own text as a
  person's, or a person's as an agent's. The last edit shown in the list is approximate when two writes race.
- The UI is English only. It needs a browser with `WebSocket` and ES2022.
- A document holds no roles of its own. The token table gives `editor` or `viewer`. To share a document
  by person, use `createSharing` from `agentic-identity` 0.4. A grant names its subject by kind
  (`human` or `agent`) and id, so a person and an agent with the same id hold separate roles. When you
  delete a document, call `deleteResource` on its resource so its grants do not outlive it. If
  `deleteResource` fails, treat the delete as failed and run it again. If it throws
  `EraseRefusedError`, remove the child resources or the extra owners first. Do not reuse the id
  until it succeeds. The `remove` command deletes the document and its catalog entry. It does not touch grants.
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
- The `export` command covers Markdown, HTML, and ODT. DOCX export, and ODT and DOCX import, are in
  `agentic-documents/formats` only.
- File formats through `agentic-documents/formats`: a quote becomes plain paragraphs, a code block becomes a paragraph
  of code text, a horizontal rule is left out, a numbered list starts at 1, and a task list becomes a list that starts
  each item with `☐` or `☑`. On import, underline, superscript, and subscript are left out, and a footnote becomes
  text in brackets, and code text keeps only its code mark. Each one is named in `warnings`.
- ODT export: a quote becomes plain paragraphs, a code block becomes a paragraph of code text, a rule is
  left out, a numbered list starts at 1, a list item keeps one paragraph, and a WebP image becomes its alt text.
  Comments and suggestions are not written. A code block loses its language. A table
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
