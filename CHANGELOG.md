# Changelog

## 0.13.2

### Changed

- Allow agentic dependencies below version 1.0.0 and test with their latest releases.

## 0.13.1

### Changed

- `agentic-design` moves from `^0.6.0` to `^0.9.0`, so apps can share one copy at 0.9.0. This package does not use the new props or components.
- Escape releases the slash menu keys before the next render, so the next arrow key reaches the text.

## 0.13.0

### Added

- Add the `./account` contributor for account export and repeatable erase.
- Export full document state and history. Preserve co-owners and machine labels.

## 0.13.0

### Added

- Public `ReviewPanel` and `CommentAnchor` components in `agentic-documents/ui`.
  Review and suggest modes show machine authors, anchored comments, and keyboard controls.
  Decisions need a different principal. Agents also need `docs:accept`.
- Root `createAssistantSuggestions`, `AssistantProposal`, and `AssistantSuggestions` exports
  give assistant adapters a typed proposal port. Hosts own persistence and provider calls.

### Changed

- The web UI opens a document full screen: a top bar with the way back, the title, Share, and a menu with Rename,
  Delete, the theme, and Sign out, then the editor with the text as a page. The side bar shows on the list only. The editor is a port of gitmarkdown (MIT).
- The editor toolbar has text style, strikethrough, inline code, task lists, quote, code block, divider, table,
  image, undo, and redo, as well as bold, italic, link, and lists. The image dialog also takes a PNG, JPEG, GIF, or
  WebP file, stored in the document, and a chosen file can be removed. Pasted HTML keeps an image only when its source
  passes the same check as the dialog. A paste or a drop whose images would take the document past the 1,000,000 byte
  limit of a live room is refused, and a save that fails on that limit says so.
- A slash menu (type `/`) adds a block, and a bubble menu over a selection formats it. Alt+F10 reaches the bubble
  menu from the keyboard. An empty document shows a hint. Both menus are ports of gitmarkdown.
- `@tiptap/extensions` is a direct dependency, for the placeholder.
- Table changes from the Table tool in a table, a language for a code block with syntax colors for twelve languages,
  and Download Markdown and Import Markdown in the document menu. New dependencies: `@tiptap/extension-code-block`,
  `@tiptap/extension-code-block-lowlight`, `lowlight` (MIT), and `highlight.js` (BSD-3-Clause, `~11.11`, the line
  that `lowlight` uses).
- `agentic-documents/ui`: the options `slashItems`, `bubbleActions`, and `extensions`, the functions `editorMarkdown`
  and `setEditorMarkdown`, and the types `SlashItem`, `BubbleAction`, and `EditorExtras`. An extension that adds or
  changes a node, a mark, or an attribute stops the editor with a message that names it. `setEditorMarkdown` throws
  on a read-only editor.
- The selection of another person in the room shows as a tint, and an agent's as a dashed outline, next to the caret
  with the name.
- The editor classes use the `agd-` prefix. Update any style that targets the old names: `.agd-doc` (was `.adoc`),
  `.agd-app` (was `.adoc-app`), `.agd-prose` (was `.prose`), `.agd-agent-text` (was `.agent-text`), `.agd-caret`,
  `.agd-caret--agent`, and `.agd-caret__tag` (were `.caret`, `.caret--agent`, and `.caret__tag`), and `.agd-muted`,
  `.agd-notice`, and `.agd-legend` (were `.muted`, `.notice`, and `.legend` under `.adoc`), `.agd-glyph`,
  `.agd-glyph--b`, and `.agd-glyph--i` (were `.glyph`, `.glyph--b`, and `.glyph--i`), `.agd-doc__meta` (was
  `.editor-meta`), and `.agd-form` and `.agd-form-actions` for the link and image
  dialogs (were `.adoc.form` and `.form-actions`). The form rules now apply page-wide, not under `.agd-doc`, since
  the dialogs render in a portal. `.editor-bar` and `.editor-host` are gone: the bar is `.agd-doc__bar` and the text sits in
  `.agd-paper`.

## 0.12.1

### Added

- The README has an import example for `agentic-documents/live-worker`, the last subpath export without one. It shows the `SyncRoom` export that the Worker's main module needs.
- A test checks that the README names every subpath export in `package.json` with an import example, and every root export in `src/index.ts`. A new export with no README section fails `npm test`.

## 0.12.0

### Added

- `agentic-documents/ui`: an Image button in the toolbar. It opens a dialog to insert an image, or to change the selected one. The
  dialog asks for alt text (WCAG 1.1.1), and has a Decorative choice that writes an empty alt. The alt text is kept in the
  document and in the Markdown and HTML reads. The ODF and OOXML exports keep a description. An empty alt is not marked as
  decorative there, and a WebP image becomes text, as before.

## 0.11.1

### Added

- The README has a table of every subpath export in `package.json`, with what each one is for.
- The README has a "Library API" section for the root export of `agentic-documents`. It has an example for each group of exports: the document, the Markdown and blocks helpers, comments and suggestions, the command table, export, the local stores, the service, and the sharing helpers.

### Changed

- `agentic-identity` moves from `^0.8.0` to `^0.9.0`, `agentic-design` from `^0.4.0` to `^0.6.0`, `agentic-realtime` from `^0.4.1` to `^0.4.4`, and `agentic-formats` from `^0.3.0` to `^0.4.2`. `agentic-design` 0.5.0 and 0.6.0 change the look and make `Tabs` use a roving tab index. `agentic-realtime` 0.4.4 uses `agentic-identity` 0.9.0, so the lockfile has one copy of it.
- `agentic-formats` 0.4.2 depends on zod 4 itself, so the `overrides` entry for `agentic-formats` is now redundant. It stays for safety.

## 0.11.0

### Changed

- BREAKING: the design class prefix is now `agd-`. The CSS classes, the custom properties, and the data attributes that used the
  old two-letter prefix change name, so `agentic-documents/ui`, `agentic-documents/ui.css`, and `agentic-documents/app.css` render with the new names. Ad
  blockers hide elements with the old prefix, so the prefix moved. There is no alias for the old names.
- `agentic-design` moves from `^0.3.1` to `^0.4.0`, which uses the `agd-` prefix.
- The `overrides` entry for `agentic-design` is gone. `agentic-design` 0.4.0 depends on zod 4 itself. The `agentic-formats` override stays.

## 0.10.0

### Added

- `agentic-documents/ui`: a `host` option for `mountEditor` and `DocumentEditor`. The app gives its own `Y.Doc`, and
  optionally the presence and the status of its room. The editor binds to that document and does not load, save, or
  join a room. `client` is optional with `host`. `onEditor` gives the app the Tiptap editor. The editor no longer
  injects an inline style. `ui.css` has its base rules.

### Added

- `agentic-documents/ui`: a `host` option for `mountEditor` and `DocumentEditor`. The app gives its own `Y.Doc`, and
  optionally the presence and the status of its room. The editor binds to that document and does not load, save, or
  join a room. `client` is optional with `host`. `onEditor` gives the app the Tiptap editor. The editor no longer
  injects an inline style. `ui.css` has its base rules.

### Changed

- The file blob store now comes from `agentic-identity/file`. `createFileBlobs(dir, options)` and `FileBlobsOptions` keep their names and are re-exported. `createFileBlobs` takes `urlBase` and `urlSecret`, and `signedUrl` needs both (it gives a signed HTTP URL, not a `file:` path). The lock options `lockStaleMs` and `lockTimeoutMs` are gone, because the shared store manages its own lock. `agentic-identity` moves to `^0.8.0`. The new store keeps blobs in `<dir>/blobs/<hash>.blob` with a new header. A blob that release 0.9 wrote (`<dir>/<hash>`) moves to the new layout on its first read, write, or delete, and the old catalog import still works. A move and a delete of one key share a lock. An old file that a newer blob replaces stays beside it with a `.superseded-<id>` suffix. A damaged old file gives an error that names it. A blob version is now an opaque token, not a content hash. A lock wait that runs out still gives `LOCKED`. The wait is now 10 seconds. The identity lock goes stale after 60 seconds, and the per-key move lock after 120 seconds.

### Fixed

- zod moves to 4.6.7 to fix GHSA-mrhx-c7xc-m3w5, a high advisory (memory exhaustion when validating oversized constrained collections). The direct dependency moves from `^3.25.0` to `^4.6.7`. An npm `overrides` entry moves `agentic-design` and `agentic-formats` to zod 4.6.7 in this repo's install and build. npm ignores `overrides` in a published package, so an install of this package still gets zod 3 under those two packages until they accept zod 4. The `@modelcontextprotocol/sdk` floor moves from `^1.12.0` to `^1.23.0`, because earlier SDK releases depend on zod 3.
- zod 4 words some validation messages differently. An `INVALID_INPUT` error can carry other message text. A client that matches on message text should match on the error code.
- The editor of `agentic-documents/ui` opens a document with an inline image or a nested task list. It showed an empty
  editor before. Its image and task item now follow the engine schema.

## 0.9.0

### Changed

- The local file `Store` is now `createFileStore` from `agentic-identity/file` (0.7). The catalog moves to
  `<dir>/store/store.json`. The first write after the upgrade imports the old catalog once. The options
  `lockStaleMs` and `lockTimeoutMs` no longer apply to the store. A write that loses a race runs again up to 64 times.
- `agentic-identity` moves from `^0.6.0` to `^0.7.0`.

### Added

- Sharing, built on the grant, invite, and link primitives of `agentic-identity`. New commands: `grants`, `grant`,
  `revoke`, `invites`, `invite`, `link`, and `unlink`. They are in the CLI, the MCP server (`doc_grants` and so on), and
  the HTTP API (`GET /api/v1/docs/:id/grants`, `POST /api/v1/docs/:id/grant`, and so on). Only an owner may use them.
  Over the HTTP API every caller needs `docs:admin`. In local mode, an agent needs it in the CLI and the MCP server too.
  A development token gives a person with the `editor` role that scope. The person who creates a document owns it, and
  with `agentic-identity` keys over the HTTP API, an agent that creates one for a person makes that person the owner. A
  link token shows once. An invite list shows no email address. Removing a document erases its sharing data. Roles are
  stored and audited. Reads and writes do not check them yet. A document with no owner record is claimed by its creator,
  when the root of the caller's delegation chain is that creator, and the caller has a write scope. A document with no creator in the catalog,
  one whose author name is not a valid grant name, or one made by an agent that acts for a person, cannot be claimed. A
  rename can record a creator for a document with no creator.
- `DocsService.sharing` and the `DocSharing` type.
- The SDK client has `grants`, `grant`, `revoke`, `invites`, `invite`, `link`, and `unlink`. The CLI and the MCP
  server run the same commands in live mode, through the server.
- The share dialog in the web UI lists who has access, changes and removes roles, makes invites, and makes and
  revokes a share link. Only an owner sees the controls. The text "not available yet" is gone.

## 0.8.0

### Removed

- **Breaking.** `DOCX_MIME`, `ODT_MIME`, `FILE_FORMATS`, and `IMPORT_FORMATS` are no longer exported. `ODT_MIME` also
  leaves the root `agentic-documents` entry. Nothing else in the package used them. The `FileFormat` and
  `ImportFormat` types stay. No runtime list replaces them. Import takes `md`, `odt`, and `docx`. Export takes `md`,
  `html`, `odt`, and `docx`.

### Changed

- **Breaking.** The Worker signs in with `agentic-identity` keys from the D1 database by default (`createStoreAuth`).
  A deployment that only sets `AGENTIC_DOCS_TOKENS` now gets 401 on every request until you add principals and keys
  to the database. A scope of `docs:write` makes an editor, no write scope makes a viewer, and `docs:admin` grants a
  principal `docs:accept` and `docs:remove`. `createApp` takes an `auth` option to bring your own `Auth` port. A
  Worker with no `AGENTIC_DOCS_REGION` now answers 500 `MISCONFIGURED` before it checks the sign-in.
- **Breaking.** `AGENTIC_DOCS_TOKENS` is ignored unless `AGENTIC_DOCS_UNSAFE_TOKENS=1` is set. It is a development
  fallback. Set the new variable where you still use the table. Without a D1 database or the switch, the Worker
  answers 500 `MISCONFIGURED`.
- **Breaking.** `agentic-realtime` moves from `^0.1.0` to `^0.4.1`. Its types change, so a custom `live` option
  typed against 0.1 must move to 0.4. Realtime 0.4 refuses an update that uses the client ids of another principal.
  Run the live Worker and its clients on 0.8.0 together.
- `agentic-design` moves from `^0.1.0` to `^0.3.1`, and `agentic-formats` from `^0.2.0` to `^0.3.0`.
- A live join seeds only the parts of the stored document that the room lacks. Two principals that join at the same
  time no longer fail: the second seed is not refused.

## 0.7.1

### Changed

- The Worker uses the `agentic-identity` 0.6 auth helpers for Bearer auth and the WebSocket token. The Worker's own
  WebSocket subprotocol parser is gone, and the Bearer header format check comes from `agentic-identity`. A token in
  `AGENTIC_DOCS_TOKENS` now holds only `A-Z a-z 0-9 _ -` (32 to 512 bytes), and a bad one refuses the whole config.
  An author name there follows the identity id rule (`A-Z a-z 0-9 . _ -`, up to 128 characters, not starting with
  `.`). A browser must offer both `agentic-docs` and `agentic-docs.bearer.<token in base64url>` as subprotocols.
- `PRINCIPAL_KINDS` and `PrincipalKind` come from `agentic-identity`. The exports of `agentic-documents` do not change.

## 0.7.0

### Added

- `agentic-documents/ui` exports `mount(element, { baseUrl, getToken, documentId?, onError? })`, which renders the whole
  app (document list, editor, rename, delete, share) in a host page, and returns `{ update, unmount }`. Its layout
  styles are in the new `agentic-documents/app.css` export. `mountEditor` is unchanged.
- A live demo Worker config, `wrangler.demo.jsonc`, and a `deploy:demo` script. The README has the steps. The demo
  database and the bucket use the EU jurisdiction.

## 0.6.0

### Added

- `agentic-documents/ui`: `mountEditor(element, { id, client, principal, room? })` and the `DocumentEditor` React component
  render the editor in a host app, with live co-editing through agentic-realtime when a room is given. Its styles are
  in `agentic-documents/ui.css`. `react` and `react-dom` are optional peer dependencies; the Tiptap packages and
  `agentic-design` are now dependencies.
- The edit log has a new op, `live`. The editor writes one `live` entry when an agent principal types, so its text is
  marked as agent work. Its counts are 0.

### Changed

- The ODT export uses `agentic-formats`. The local ODT writer and the `fflate` dependency are gone. `exportOdt` and
  `ODT_MIME` stay as thin wrappers. The ODT file now comes from the neutral text model, so its XML differs from before.
- The ODT export holds less than before, because the agentic-formats text model has no block for a quote, a rule, or a
  code block, no list start number, one paragraph for each list item, and no WebP image. The text stays.
  `ExportResult` has a `warnings` field that names each loss. It is empty for `md` and `html`. The field is required, so
  code that builds an `ExportResult` by hand must add it. The CLI prints each warning on stderr. The HTTP API sends them
  in the `x-export-warnings` header.

## 0.5.0

### Breaking

- A deploy from the template `wrangler.jsonc` needs `npm run build` first. The file now has an `assets` entry for
  `dist/ui`, so `wrangler` stops when that folder is missing.

### Added

- Commands `list`, `rename`, and `remove` in the SDK, CLI, MCP server, HTTP API (`GET /api/v1/docs`), and
  the typed client. The catalog keeps a title and the last save time and author. An agent needs the
  `docs:remove` scope to remove a document.
- A browser can open a live room: the token goes in a WebSocket subprotocol
  (`agentic-docs.bearer.<base64url>`) on the live-room route only.
- A web UI that the Worker serves from `dist/ui` (the `assets` entry in `wrangler.jsonc`): a document list, a
  rich-text editor on the live room, rename, delete, share, presence, and a mark on agent text. It is built on
  `agentic-design` and the typed client. Playwright tests run it under `wrangler dev` with an axe check (WCAG 2.2 AA rules)
  in the light and the dark theme, and screenshots are in `docs/screenshots`.
- The saved update may hold the marker root that the Tiptap editor writes when it opens a document.
- `POST /checkpoint?create=false` (client option `create: false`) fails with `NO_DOCUMENT` instead of making a missing document. The UI saves this way, so a removed document stays removed.
- Each edit log entry holds `client`, the Yjs client id of its writer, so a UI can mark agent text.
- `agentic-documents/formats`: `importFile` (md, odt, docx) and `exportFile` (md, html, odt, docx), with the
  `toTextDoc` and `fromTextDoc` mapping to the agentic-formats text model. Each result names lost content in `warnings`.
- `AgenticDoc.fromBlocks(blocks, author)` makes a document from ProseMirror JSON blocks and checks them against the schema.

### Changed

- `esbuild` is a declared dev dependency. `ui/build.mjs` uses it.

### Fixed

- In the web UI, the caret goes after a new link, and text typed there does not join the link. A quick key
  after Apply no longer replaces the linked words. Apply with no words selected keeps its link for the next text.
- In the web UI, a key typed right after a toolbar button goes to the text, not to the button.

## 0.4.0

### Added

- A typed client for the Worker HTTP API: `createClient({ baseUrl, token, fetch? })` from the new
  `agentic-documents/client` subpath. It has one method per HTTP route, except the WebSocket route. It throws `DocsApiError` with the API
  error code and the HTTP status, takes an `AbortSignal` on every call, and never retries. A 2xx reply
  with the wrong content type or shape throws `DocsApiError` with the code `BAD_RESPONSE`. It uses only
  `fetch`, so it runs in browsers, Workers, and Node 22. Tests run it against the real Worker under
  `wrangler dev`.

Nothing else changed since 0.3.0.

## 0.3.0

### Breaking changes

The API of this package does not change. The change is in the dependency.

- **Dependencies.** `agentic-identity` moves from `^0.3.0` to `^0.4.0`. In 0.4 a grant is keyed on the
  principal kind and the id, so a person and an agent with the same id hold separate roles. Grants
  written by 0.3 are not honored until you run `migrateGrants`. A host that shares documents through
  `createSharing` must pass `{ kind, id }` to `grant` and `revokeGrant`.

### Added

- Tests that a person and an agent with the same id get separate roles, and that `deleteResource`
  removes the grants.
- This package has no grant call and no command that deletes a whole document or erases a person. A
  host that deletes a document must call `deleteResource` for it, and must delete the document and its
  catalog entry itself. If `deleteResource` fails, run it again. If it throws `EraseRefusedError`,
  remove the child resources or the extra owners first. Do not reuse the document id until it
  succeeds. The `agentic-identity` person erase does not remove document content, and author names
  stay in the edit log, the threads, and the suggestions.

## 0.2.0

### Breaking changes

- **Worker deployments from the repo template.** `wrangler.jsonc` now sets `main` to
  `src/live-worker.ts`. To host live rooms, add the `SYNC_ROOM` Durable Object binding and the `v1`
  migration (`new_sqlite_classes`). Without the binding, the room routes fail with `MISCONFIGURED`.
  The published package does not include `wrangler.jsonc`.
- **Token table.** An `AGENTIC_DOCS_TOKENS` entry in object form may now carry a `role`. A `role` that
  is not `editor` or `viewer` refuses the whole token table, so a typo never leaves a token live with
  the wrong role. Entries with no `role` stay editors, as before.
- **Dependencies.** `agentic-identity` moves from `^0.2.0` to `^0.3.0`.

### Added

- Live rooms. Several people and agents edit one document at the same time. Import `LiveDoc` from
  `agentic-documents/live`. Deploy `agentic-documents/live-worker` to host the rooms.
- The `agentic-realtime` dependency (`^0.1.0`, the version on npm) for the live rooms.
- `--live <url>` on the CLI and the MCP server, or `AGENTIC_DOCS_LIVE_URL`. Set `AGENTIC_DOCS_TOKEN`
  to join a room. The server sets the author kind and the role from the token.
- With `--live`, the CLI refuses `--as`, `--scopes`, and `--dir`, and exits 2. The server sets these
  from the token.
- A `viewer` role. A viewer reads and cannot write, over HTTP or in a live room. The default role is
  `editor`.
- Worker routes for live rooms: `GET /api/v1/me`, `GET /api/v1/docs/:id/room`,
  `GET /api/v1/docs/:id/ws`, `GET /api/v1/docs/:id/state`, and `POST /api/v1/docs/:id/checkpoint`.
- Live rooms save through the shared `Store` and `Blobs` ports. A stored document too big for a room
  fails the join with a clear error.
- `npm pack` and `npm publish` build `dist/` first (`prepack`).

## 0.1.0

- First release. The document model, the Markdown and ODT export, the text operations, the CLI, the
  MCP server, and the Worker HTTP API.
