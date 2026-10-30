# agentic-documents

[![npm version](https://img.shields.io/npm/v/agentic-documents)](https://www.npmjs.com/package/agentic-documents)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-documents) · [Source](https://github.com/pooriaarab/agentic-documents) · [Support](https://github.com/pooriaarab/agentic-documents/issues)

Write documents with people and agents in real time.

> Status: early, version 0.13.0. The document model, the text operations, the CLI, the MCP server,
> the Worker API, live editing in a room, and a small web UI work. See [UI](#ui).

## Install

```sh
npm install agentic-documents
```

## Subpath exports

| Import | Use it for |
| --- | --- |
| `agentic-documents` | The document model, text operations, threads, suggestions, the service, the file store, export, the sharing API, and their types. See [Quick start](#quick-start). |
| `agentic-documents/worker` | The HTTP API as a Hono app. See [Worker subpath](#worker-subpath). |
| `agentic-documents/live` | `LiveDoc`, the client for a live room. See [Live editing](#live-editing). |
| `agentic-documents/client` | A typed client for the Worker API. See [SDK](#sdk). |
| `agentic-documents/formats` | Import and export files. See [File formats](#file-formats). |
| `agentic-documents/ui` | Mount the editor, or the whole app, in your page. See [Embed the editor](#embed-the-editor) and [Mount the whole app](#mount-the-whole-app). |
| `agentic-documents/ui.css` | The base styles of the editor. Load it after `agentic-design/styles.css` and with `agentic-documents/ui`. See [Embed the editor](#embed-the-editor). |
| `agentic-documents/app.css` | The layout styles of the whole app. Load it after `agentic-documents/ui.css`. See [Mount the whole app](#mount-the-whole-app). |
| `agentic-documents/live-worker` | The HTTP API with live rooms, as a Worker. It exports `SyncRoom`. See [Live editing](#live-editing). |

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
and the typed client (`agentic-documents/client`). It has a document list, a full-screen rich-text editor, rename,
delete, a share dialog, the people and agents in the room, and a dotted underline on text that an agent wrote. The
editor toolbar has text style (paragraph, headings 1 to 3), bold, italic, strikethrough, inline code, link, bulleted,
numbered, and task lists, quote, code block, divider, table, image, undo, and redo. The Image tool inserts an image, or changes the selected one, with alt text or
the Decorative choice. It takes a web address, an embedded image, or a PNG, JPEG, GIF, or WebP file of up to about 180
KB, stored in the document. The page's content security policy blocks images from other hosts, so a web address shows
only in an app that allows it. A pasted image is kept only when its source passes the same check. A paste or a drop
whose images would take the document past the 1,000,000 byte limit of a live room is refused. The menu at the top end of a document has Rename,
Delete, the theme, and Sign out. The tests check each main view with axe (WCAG 2.2 AA rules) in the light and the dark theme: sign in, list, empty and error list, new-document dialog, editor, share dialog, link, rename and delete dialogs, the actions menu, and the read-only view. Axe finds only part of the faults, so it does not replace a test with a screen reader. Screenshots of
every view are in [docs/screenshots](docs/screenshots).

Type `/` at the start of a line, or after a space, to add a block: a list box under the slash shows text, headings,
lists, quote, code block, divider, table, and image. A word after the slash filters it. The arrow keys move in it,
Enter or Tab picks, and Escape closes it. The text keeps the focus and names the active item for a screen reader.
Select text to get a bubble menu with bold, italic, strikethrough, inline code, and link. Alt+F10 moves the focus
into it, and Escape gives the focus back to the text. An empty document says how to start.

In a table, the Table tool opens the table changes: add a row above or below, add a column before or after, delete a
row or a column, and delete the table. Markdown tables always have a header row, so when the selection covers the
header row there is no Add row above and no Delete row. When the selection covers every column, Delete table removes
them. In a code block, a Code language tool sets the language of the fence. Twelve languages have syntax colors
(Shell, CSS, Go, HTML, JavaScript, JSON, Markdown, Python, Rust, SQL, TypeScript, YAML). Any other language shows as
plain text: it is never guessed. The colors are decorations, so the stored text has none. The document menu has
Download Markdown, which saves the text as a `.md` file named after the title, and Import Markdown, which replaces the
text for everyone in the room with a `.md` file of 512 KB or less, when the projected document state stays under
the room limit. The check counts old text that Undo keeps. Both
use the same conversion as `doc_read` and `doc_new`, so an import refuses what `doc_new` refuses (a footnote, for
example). An image that a paste would not keep is dropped. Undo takes an import back.

Run it on your machine:

```sh
npm ci
npm run build                      # writes dist/ and dist/ui
export WRANGLER_SEND_METRICS=false
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
npx wrangler dev --var AGENTIC_DOCS_REGION:unknown --var AGENTIC_DOCS_UNSAFE_REGION:1 \
  --var AGENTIC_DOCS_UNSAFE_TOKENS:1 --var "AGENTIC_DOCS_TOKENS:{\"$TOKEN\":\"human:Ada\"}"
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

Add the D1 and R2 bindings from the sample `wrangler.jsonc`. The Worker signs in with `agentic-identity` keys from the D1 database (see [Sign-in](#sign-in)).
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
curl -X POST $URL/api/v1/docs/plan/grant -H "authorization: Bearer $TOKEN" -d '{"to":"human:kit","role":"editor"}'   # owner only
# add &remoteImages=true to keep web images; the default shows only images stored inside the document
```

- Each key stands for one principal. See [Sign-in](#sign-in). A body cannot name its own author.
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
  `grants`, `grant`, `revoke`, `invites`, `invite`, `link`, `unlink`, `export`, `room`, `me`, `health`, `state`, and `checkpoint`. The WebSocket route is not a method. Use
  `LiveDoc` from `agentic-documents/live` for it.
- Every method takes an optional `{ signal }` last. An abort rejects with what `fetch` throws.
- An API error throws `DocsApiError` with `code` (the API error code), `status` (the HTTP status), and
  `matches`. A reply that is not an API error has the code `HTTP_ERROR`. A 2xx reply with the wrong content type or shape has the code `BAD_RESPONSE`.
- The client never retries. A write is not safe to send twice.
- Pass `fetch` to use your own, for a Worker service binding or for tests.

## Library API

The root import, `agentic-documents`, exports the document model and the helpers that the CLI, the MCP server, and the
Worker use. Each group below has a short example. The other subpaths have their own sections: [SDK](#sdk),
[File formats](#file-formats), [Worker subpath](#worker-subpath), [Live editing](#live-editing), and [UI](#ui).

| Export | Use it for |
| --- | --- |
| `AgenticDoc`, `DocOptions`, `Section`, `Target`, `TextTarget`, `SectionTarget`, `Anchor`, `AnchorTarget`, `EditEntry` | The document. See [Quick start](#quick-start). |
| `DocError`, `DocErrorCode` | The error that a failed call throws. It has a `code`. |
| `parseAuthor`, `PRINCIPAL_KINDS`, `Principal`, `PrincipalKind` | Read a `kind:name` string. List the kinds. |
| `markdownToBlocks`, `blocksToMarkdown`, `PmNode`, `schema` | Convert Markdown to and from ProseMirror JSON. `schema` is the editor schema. |
| `Threads`, `Suggestions`, `Thread`, `Suggestion`, `Message` | Comments and suggested edits on text. |
| `commands`, `Command` | The command table. The CLI, the MCP server, and the HTTP API each read it. |
| `EXPORT_FORMATS`, `exportDoc`, `ExportFormat`, `ExportOptions`, `ExportResult` | Export a document as `md`, `html`, or `odt`. |
| `exportOdt` | Write blocks as an OpenDocument text file. It returns bytes. |
| `createFileStore`, `createFileBlobs`, `FileBlobsOptions` | The local file store. It keeps the catalog and the document bytes. |
| `DocsService`, `DocsPorts`, `DocInfo` | Create, read, change, and share documents over a store and blobs. |
| `ROLES`, `INVITE_ROLES`, `SHARE_SCOPE`, `parseSubject`, `contextOf`, `StoreSharing`, `DocSharing`, `GrantInput`, `InviteInput`, `LinkInput` | Roles, sharing helpers, and the sharing port. |

### Document and author

```ts
import { AgenticDoc, parseAuthor, PRINCIPAL_KINDS } from "agentic-documents";

PRINCIPAL_KINDS; // "human", "agent_of_human", "agent_of_agent", "agent", "user_token"
parseAuthor("agent_of_human:scribe"); // { kind: "agent_of_human", name: "scribe" }

const doc = AgenticDoc.fromMarkdown("# Plan\n\nShip on Friday.", { kind: "agent_of_human", name: "scribe" });
doc.replace({ text: "Friday" }, "Monday", { kind: "agent_of_human", name: "scribe" });
```

- `parseAuthor` returns `undefined` for no value. It does not check the kind. A change checks it and throws `DocError` with `INVALID_AUTHOR`.

### Markdown and blocks

```ts
import { blocksToMarkdown, markdownToBlocks, schema } from "agentic-documents";

const blocks = markdownToBlocks("# Plan\n\nShip **Friday**.");
blocks[0].type; // "heading"
blocksToMarkdown(blocks); // "# Plan\n\nShip **Friday**.\n"
schema.nodeFromJSON(blocks[0]); // a ProseMirror node, for an editor you build yourself
```

### Comments and suggestions

```ts
import { AgenticDoc, Suggestions, Threads } from "agentic-documents";

const person = { kind: "human", name: "ada" } as const;
const agent = { kind: "agent_of_human", name: "scribe" } as const;
const doc = AgenticDoc.fromMarkdown("# Plan\n\nShip on Friday.", person);

new Threads(doc).add({ text: "Friday" }, "Is this date firm?", agent); // returns the thread id
const change = new Suggestions(doc).add({ text: "Friday" }, "Monday", agent); // returns the suggestion id
new Suggestions(doc).accept(change, person);
```

- `Threads` has `add`, `reply`, `resolve`, `reopen`, and `list`. `Suggestions` has `add`, `accept`, `reject`, and `list`.
- A person (`human` or `user_token`) accepts a suggestion that someone else made. An agent accepts one only when it holds the `docs:accept` scope. Nobody accepts their own suggestion. Otherwise the call throws `FORBIDDEN`.

### Commands

```ts
import { commands } from "agentic-documents";

// `service` is a DocsService, as in "Stores". `author` is a Principal.
commands.map((command) => command.name); // "new", "list", "read", "replace", "export", ...
const read = commands.find((command) => command.name === "read")!;
await read.run(service, { id: "plan" }, author); // the same call the CLI, MCP, and HTTP make
```

- A `Command` has `name`, `description`, `shape` (a Zod shape for the input), `readOnly`, and `run(service, input, author, context?)`.
- Use the table to list or call the commands in your own host. Each call still needs an author.

### Export

```ts
import { exportDoc, exportOdt, markdownToBlocks } from "agentic-documents";
import { writeFile } from "node:fs/promises";

// `doc` is an AgenticDoc, as in "Document and author".
const md = exportDoc(doc, "md"); // { format, contentType, encoding: "utf8", data: "# Plan...", warnings: [] }
const odt = exportDoc(doc, "odt"); // encoding "base64": data is the .odt file in base64
await writeFile("plan.odt", exportOdt(markdownToBlocks("# Plan\n\nShip on Friday.")));
```

- `exportDoc(doc, format, { remoteImages? })` returns an `ExportResult`. For `odt` it sets `encoding` to `base64`. For `md` and `html` it sets `utf8`.
- `exportOdt(blocks)` returns the bytes of an `.odt` file. It drops the warnings. Use `exportDoc`, or `exportFile` from [File formats](#file-formats), to read them.

### Stores

```ts
import { createFileBlobs, createFileStore, DocsService } from "agentic-documents";
import { join } from "node:path";

const dir = ".agentic-documents";
const service = new DocsService({
  blobs: createFileBlobs(join(dir, "blobs")),
  store: createFileStore(join(dir, "store")),
});
```

- `createFileStore(dir, options?)` keeps the catalog in `<dir>/store.json`. Two stores on the same path share data across processes. A write that loses a race runs again, up to 64 times, then throws `StoreConflictError`.
- `createFileBlobs(dir, options?)` keeps each document as a file under `<dir>/blobs/`. A conditional write that loses returns `null`. A lock wait that runs out (10 seconds) throws `LOCKED`.
- Both take `region`. `now` sets the clock, for tests. `createFileBlobs` also takes `urlBase` and `urlSecret` (32 bytes or more). With both set, `signedUrl` returns a signed HTTP URL.
- Release 0.9 and earlier kept blobs in `<dir>/<hash>`. The first read or write of a key moves its old blob to the new layout. A delete removes it.
- The CLI uses `<dir>/blobs` and `<dir>/store`, as in the example above. So the CLI's blob files sit in `<dir>/blobs/blobs/`.

### Service

```ts
const ada = { kind: "human", name: "ada" } as const;

await service.create("plan", "# Plan\n\nShip on Friday.", ada);
await service.write("plan", (doc) => doc.replace({ text: "Friday" }, "Monday", ada), ada);
await service.read("plan", (doc) => doc.toMarkdown()); // "# Plan\n\nShip on Monday.\n"
await service.list(); // [{ id: "plan", title: "plan", createdBy, createdAt, updatedAt, updatedBy }]
```

- `DocsService` takes `{ blobs, store }` (the `DocsPorts`) and optional `DocOptions`.
- `service.info(id)` returns a `DocInfo` with `createdBy` and `createdAt`, or `null` when the document has no catalog entry. A `list` row adds `id`, `title`, `updatedAt`, and `updatedBy`.
- `create` throws `DOCUMENT_EXISTS` when the id is taken. `write` saves only when nobody saved in between. If someone did, it loads the document and runs your callback again, up to 64 times, then throws `CONFLICT`.
- `read` gives the document to a callback and returns the callback's result.
- `service.sharing` is a `StoreSharing`. See the next group.

### Sharing helpers

```ts
import { contextOf, INVITE_ROLES, parseSubject, ROLES, SHARE_SCOPE } from "agentic-documents";

ROLES; // "viewer", "commenter", "editor", "owner"
INVITE_ROLES; // "viewer", "commenter", "editor"
SHARE_SCOPE; // "docs:admin"
parseSubject("agent:scribe"); // { kind: "agent", id: "scribe" }

const ada = { kind: "human", name: "ada" } as const;
await service.sharing.grant(contextOf(ada), "plan", parseSubject("human:grace"), "editor");
await service.sharing.grants(contextOf(ada), "plan");
```

- `contextOf(author)` gives the sign-in context for a call that has no HTTP sign-in: the CLI, the MCP server, and the development token table. A `human` holds `docs:admin`. Any other kind keeps only its `read`, `comment`, `write`, and `admin` scopes.
- Each sharing call needs an owner of the document. The creator of a document is its owner, unless the author cannot own one.
- `StoreSharing` implements `DocSharing`. It takes the store and a lookup for documents. `DocsService` builds it for you. `GrantInput`, `InviteInput`, and `LinkInput` are the input types.

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
- The styles sit under the `.agd-doc` class and use the agentic-design tokens, except the form rules of the link and
  image dialogs (`.agd-form`, `.agd-form-actions`), which apply page-wide because the dialogs render
  in a portal. Load `agentic-design/styles.css` first.
- File import and export are in `agentic-documents/formats` (see [File formats](#file-formats)).
- Extension points for an app, such as comments or an assistant:
  - `slashItems`: more slash menu items, after the built-in ones. Each is `{ title, description, keywords?, icon?, run(editor) }`.
  - `bubbleActions`: more tools in the bubble menu over a selection, after the built-in ones. Each is
    `{ label, icon, run(editor) }`. `run` gets the editor with the selection in place. They show where the built-in
    tools show: for a person who can edit, over text that is not code, an image, or a cell selection.
  - `extensions`: more Tiptap extensions: plugins, decorations, and keyboard shortcuts. Keep this array stable.
    The editor reads it when it is built, including after a role or room change. Updating the array alone does not
    rebuild the editor. To apply new extensions at once, unmount the editor and mount it again.
    An extension that adds or changes a node, a mark, or an attribute stops the editor with a message that names it,
    since the stored document keeps only the nodes, marks, and attributes of `schema`.
  - `editorMarkdown(editor)` and `setEditorMarkdown(editor, markdown)` read and replace the text as Markdown,
    with the same Markdown conversion as the server. Import drops images that a paste would refuse.
    `setEditorMarkdown` throws if the editor is read only, has no sync document, or the projected Yjs state,
    including text kept for Undo, exceeds the room budget.
  - Invalid host options throw a `TypeError` before the editor opens or updates.
  - The types `SlashItem`, `BubbleAction`, and `EditorExtras` are exported.
- The carets and the selections of the other people and agents in the room show in the text, each with the name that
  the server stamped for that peer. A person's selection is a tint. An agent's caret and selection are dashed, so its
  selection does not look like agent-written text.
- `onEditor` gets the Tiptap editor when it is ready, and `null` when it goes. Use it to read the selection or the
  JSON, or to insert content. The editor sets `injectCSS: false`, and `ui.css` has the base rules, so a page whose
  content security policy forbids inline styles shows it right.

### Use your own Yjs document

An app that keeps the document in its own Yjs room gives it as `host`. The editor then binds to that document. It does
not load, save, join a room, or close it, and it shows no save state. The app does all of that. `client` is not needed,
and `room` together with `host` throws a `TypeError`.

```ts
const editor = mountEditor(element, {
  id: "plan",
  principal,
  host: {
    doc, // a Y.Doc. The editor reads and writes its `default` XML fragment.
    presence: sync, // optional: a SyncClient of agentic-realtime, or { awareness, peers, onPeers }
    status: () => status, // optional: "connecting" | "connected" | "disconnected"
    onStatus: (listener) => stop, // optional: tell the editor when the status changes
  },
});
```

- Use the same `yjs` copy as the editor. A document from another copy is refused with a `TypeError`.
- With `presence`, the editor shows the peers and their carets. It reads the name and the Agent tag from `peers`, so
  give peers whose `machine` flag the server sets. `peers` must always give the current list, as the getter of a
  `SyncClient` does. A list that `onPeers` updates but `peers` does not leaves the carets undrawn.
- The editor binds again only when `doc` or `presence` changes. A new `host` object with the same two keeps it as is.
  So keep the same `presence` object between renders: a new one rebuilds the editor, and the caret and the selection go.
  It reads `onStatus` once each time it binds.
- With `host`, `id` only names the editor: nothing loads by it. A new `id` in `update` still builds a new editor.
- `onEditor` is read when the editor is made. That callback gets `null` when the editor goes, after the editor is
  destroyed, so do not read from it then. A new `onEditor` in
  `update` is used for the next editor.
- When an agent principal types, the editor writes one `live` entry to the `edits` array of the document, as above.

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

## Sharing

A document has roles: `viewer`, `commenter`, `editor`, and `owner`. Grants, invites, and links come from
`agentic-identity`. Only an owner may use them. The person who creates a document owns it. Over the HTTP API, with
`agentic-identity` keys, an agent that creates a document for a person makes that person the owner. Over the HTTP API,
a caller also needs the `docs:admin` scope (or `*:admin`). That holds for a person and for an agent. In local mode, the
CLI and the MCP server give a person that scope, and an agent needs `--scopes docs:admin`. With `--live`, the token sets
the scopes. A development token gives a person with the `editor` role that scope too. Everyone else gets
`FORBIDDEN` (HTTP 403), and an agent cannot grant itself a role.

```sh
npx agentic-documents grant plan --to human:kit --role editor     # --to is human:<id> or agent:<id>
npx agentic-documents grants plan                                 # who holds a role
npx agentic-documents revoke plan --to human:kit
npx agentic-documents invite plan --role viewer --email kit@example.com   # or --handle <agent>
npx agentic-documents link plan --role viewer --expiresAt 1893456000000 --signedInOnly true   # the token shows once
npx agentic-documents unlink plan --link <link id>
```

The same commands are MCP tools (`doc_grant` and so on), HTTP routes (`POST /api/v1/docs/:id/grant`), and SDK methods
(`docs.grant("plan", { to: "human:kit", role: "editor" })`). An invite list shows no email address. A document can have
no owner record. This happens to a document made before sharing. It also happens when its author had no `docs:write`
scope, or when its author name is not a valid grant name (1 to 128 letters, digits, `-`, and `_`). The creator claims
such a document with a write scope, when the root of the caller's delegation chain is that creator. A document with no
creator in the catalog, one whose author name is not a valid grant name, or one made by an agent that acts for a person,
cannot be claimed. A rename can record a creator for a document with no creator, so check again after a rename.

## Features

- A Yjs document that a Tiptap editor can open. It uses the y-prosemirror layout.
- Headings, paragraphs, lists, task lists, tables, code, images, links, and marks.
- Markdown in and out.
- An outline. Each section has an id that stays the same when people edit around it. Blocks before the
  first heading are the `preamble` section (level 0). It is listed when they exist, and it is always a
  valid target. A replace or delete on it has no heading to keep.
- Share a document: roles, invites, and share links, for an owner (see [Sharing](#sharing)).
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

## Worker subpath

`agentic-documents/worker` is the HTTP API as a Hono app. Use it to run the API in your own Worker. It exports:

| Export | Use it for |
| --- | --- |
| `default` | A Worker `{ fetch }` over D1 and R2, with no live rooms. |
| `createApp(source, options?)` | The Hono app. `source` is a `DocsService`, or a function from the bindings to one. `options.live` makes the live-room server. `options.auth` makes the `Auth` port. |
| `serviceFor(env)` | The `DocsService` over the `DB` and `DOCS` bindings, after the region check. |
| `regionOf(env)` | The region claim from `AGENTIC_DOCS_REGION`. It throws `MISCONFIGURED` for a missing or unsafe claim. |
| `WorkerEnv`, `AppOptions`, `ServiceSource`, `DocRole` | Types. |

```ts
import { createApp, serviceFor, type WorkerEnv } from "agentic-documents/worker";

const app = createApp(serviceFor);
export default { fetch: (request: Request, env: WorkerEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
```

For live rooms, deploy `agentic-documents/live-worker` instead (see [Live editing](#live-editing)).

## Sign-in

The Worker reads Bearer keys with `createStoreAuth` from `agentic-identity`. The principals and the keys live in
the `principals` and `credentials` collections of the D1 database that the Worker already binds as `DB`. Make them
with `agentic-identity` (its server, its CLI, or `issueCredential`) against that database. A key that is missing,
expired, or revoked gets 401. A revoked agent stops, and so does every key below it.

- The key sets the author. The principal id is the author name, and the principal kind is the author kind.
- The role comes from the scopes of the principal, after the delegation chain narrows them. `docs:write` (or `docs:admin`, or
  `*:write`, or `*:admin`) makes an editor. A principal with no write scope is a `viewer`: it reads and cannot write.
- `docs:admin` also grants an agent the `docs:accept` and `docs:remove` scopes. A person needs no scope for either.
- The Worker takes no sign-in from the request body, and it ignores `AGENTIC_DOCS_TOKENS` unless you switch it on.

### Development fallback: a static token table

For local work with `wrangler dev`, you can use a fixed table of tokens. It has no expiry and no revocation, so
never use it in production. Set both variables:

- `AGENTIC_DOCS_UNSAFE_TOKENS=1` switches the table on. With any other value the table is ignored.
- `AGENTIC_DOCS_TOKENS` is a JSON object from token to author: `{"<32 or more random bytes>":"agent_of_human:scribe"}`.
  To give an agent the right to accept suggestions, use `{"as":"agent_of_human:approver","scopes":["docs:accept"]}` as the value.
  For a read-only token, use `{"as":"human:Vic","role":"viewer"}`. A token with no role is an editor.
  Make a token with `openssl rand -hex 32`. A token holds only `A-Z a-z 0-9 _ -` (32 to 512 bytes), and an
  author name holds only `A-Z a-z 0-9 . _ -` (up to 128 characters, not starting with `.`, no space or `@`).
- A token under 32 bytes, a token with other characters (for example base64 with `+` or `/`), a value that is not a valid author, or a value that is not a JSON
  object makes the Worker refuse every request (401). It logs the reason once, never the token.

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

The demo is a staging build, so it sets `AGENTIC_DOCS_UNSAFE_TOKENS=1` and reads its static token table. The tokens live in a Worker secret, never in the repo or in CI. Set them with
`WRANGLER_SEND_METRICS=false npx wrangler secret put AGENTIC_DOCS_TOKENS --config wrangler.demo.jsonc`. To make your own demo, copy
`wrangler.demo.jsonc`, change the name, and put your own database id and bucket name in it. Make the database with
`WRANGLER_SEND_METRICS=false npx wrangler d1 create <name> --jurisdiction eu`, because the jurisdiction is fixed when you create it. Make the bucket with
`WRANGLER_SEND_METRICS=false npx wrangler r2 bucket create <name> --jurisdiction eu`.

## Live editing

A person and an agent can edit one document at the same time. Each sees the other's changes. The Worker
hosts one room per document, on a Durable Object, through [agentic-realtime](https://www.npmjs.com/package/agentic-realtime).
Deploy `agentic-documents/live-worker`. The sample `wrangler.jsonc` binds `SYNC_ROOM` and sets the migration.
Your Worker's main module must export the `SyncRoom` class, as the example does.

```ts
import worker, { SyncRoom } from "agentic-documents/live-worker";

export { SyncRoom };
export default worker;
```

A person or an agent joins a room with `LiveDoc`:

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
  A principal with no `docs:write` scope is a viewer (see [Sign-in](#sign-in)). In the development token table, use `{ "as": "human:Vic", "role": "viewer" }`.
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

- The UI has no accounts. You paste a token, and the token sets your role. The share dialog lists, changes, and
  removes roles, makes invites, and makes a share link, for an owner (see [Sharing](#sharing)).
- The UI marks agent text from the edit log, which a client writes. A modified client can mark its own text as a
  person's, or a person's as an agent's. The last edit shown in the list is approximate when two writes race.
- The UI is English only. It needs a browser with `WebSocket` and ES2022.
- Sharing stores roles, invites, and link tokens. The document commands do not check them yet: a token's role
  (`editor` or `viewer`) still decides what it may do. Nothing sends an invite email, and nothing accepts an
  invite or opens a link token in this package yet. The list of links is not available, so keep the id of a link
  that you make. The share dialog shows it next to the token. Removing a document erases its sharing data.
- The Worker keeps each document in R2 and a catalog (who made it, and when) in D1. Both come from the
  shared `agentic-identity` ports. A save is conditional on the version it read, so two writers cannot
  overwrite each other. The CLI and MCP server keep the same data in local files.
- The CLI and MCP server keep files under `<dir>/blobs` and `<dir>/store`. The catalog is `<dir>/store/store.json`,
  from `agentic-identity/file`. The first write after an upgrade imports the catalog of release 0.8 once. Files from an
  older release that sit directly in `<dir>` are not read. The catalog store waits for a rival process with a short
  lock, runs a write again up to 64 times, then fails with `StoreConflictError`. The wait blocks the process.
- A key's role comes from its scopes: `editor` with a scope that covers `docs:write`, `viewer` without one. A
  development token (see [Sign-in](#sign-in)) sets its own role instead. A viewer cannot call a write command or write
  in a live room. The role is not per document: the Worker does not check the roles that sharing stores yet.
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

## Run locally

```sh
bun install        # or: npm ci
bun run dev        # or: npm run dev
curl http://localhost:8787/health
```

The script builds the app, then runs `wrangler dev` with the region check off (`AGENTIC_DOCS_REGION=unknown`). `/health` needs no token. To sign in to the UI on your machine only, pass a static token: `TOKEN=$(openssl rand -hex 32); echo "$TOKEN"; npm run dev -- --var AGENTIC_DOCS_UNSAFE_TOKENS:1 --var "AGENTIC_DOCS_TOKENS:{\"$TOKEN\":\"human:Ada\"}"`.

The scripts call `npm` and `node` (Node 22 or newer), so install both, even if you use bun. They need a POSIX shell.

Run `npm run dev:smoke` to check this path. It starts the dev server on port 8799, waits for `GET /health` to answer 200, and stops the server. CI runs it as the "dev smoke" step. Set `DEV_SMOKE_PORT` to use another port.

## Develop

```sh
npm ci
npm run ci:local
```

## Account export and erase

Use `documentsAccount` from `agentic-documents/account` with the identity account
registry that exposes `AccountPackage`, or call it directly. Identity 0.9 uses
the older `AccountApp` contract and needs a host adapter.
The subject is `{ id, kind }`. Call once for each principal, including delegated
agents. Kinds keep people and agents distinct.
The host authenticates the subject and authorizes the account operation.

```ts
import { documentsAccount } from "agentic-documents/account";
const subject = { id: "ada", kind: "human" } as const;
const data = await documentsAccount.exportAccount(subject, { store, blobs });
const counts = await documentsAccount.eraseAccount(subject, { store, blobs });
```

The export returns plain JSON collections:

- `documents` holds owned catalog rows and Markdown.
- `blobs` holds their full Yjs state as base64. This includes history, comments,
  suggestions, inline images, and collaborators' content.
- `grants` holds the subject's roles on documents and folders.
- `sharing` holds sharing rows for owned resources and invites the subject made.
- `authored` holds the subject's own author records on other documents.
  It does not include document snapshots or other people's messages.

The package stores no separate attachment or version files.
Image URLs refer to external data.

Erase deletes sole-owned documents and their sharing records.
It deletes sole-owned folders after their children. A folder with a child that
must stay stops the operation before any change.
Shared resources keep other owners and their content.
The contributor handles documents and their parent folders.
It also handles empty folders on which the subject holds a grant.
Other apps' resources stay outside the export and erase.
The subject's grants and invites go. A grant counted in `grants` is also counted
in `sharing` when it goes. Author names become `(erased)` in catalog rows,
edits, comments, suggestions, and acceptance records.
The kind stays, so machine-made work stays labeled.
Shared text stays, including personal data within text.
A second erase counts zero. A failed erase throws. Retry to finish it.
Damaged blobs, catalog rows, grants, and owner paths stop the operation.
Legacy grant keys with a valid kind work without migration.
Run `migrateGrants` first for older grants.
A grant with no kind on a document or its folder stops the operation.

Stop writes before export and keep them stopped until erase ends.
Pass `saveRoom(id)` to flush live rooms before reads.
Pass `eraseRoom(id)` to clear rooms before deletion or anonymization.
Without these hooks the host must stop and clear rooms itself.
Run this contributor before identity account erasure.
The host exports identity audit rows before erase.
This contributor deletes audit rows for each resource it deletes.
It does not export or count audit rows.
The host handles the other identity audit rows.

The contributor scans catalog and sharing rows. For legacy blobs with neither
row, pass `documentIds: async () => ids` from a complete storage inventory. The
Blobs port cannot list keys. A legacy document without an owner record uses its
catalog creator as owner only for a person or independent agent with a valid
grant name.
A delegated agent cannot claim it. A blob without either record can only be
matched by its author records.
Migrate old file blobs before account operations.
Backups and external image hosts need their own retention and erase steps.

Invites keep a creator id with no kind. Use unique ids across principal kinds.
Invites with the subject's creator id are exported and deleted. Invite recipients
cannot be matched to an account. Links have no creator record and leave with
the document.

## License

MIT. The editor is a port of [gitmarkdown](https://github.com/pooriaarab/gitmarkdown) (MIT), and its page layout
follows [tinylittleoffice](https://github.com/aboard-io/tinylittleoffice) (MIT). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
