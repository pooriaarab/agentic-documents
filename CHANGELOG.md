# Changelog

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
