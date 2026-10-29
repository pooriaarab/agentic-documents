# Changelog

## 0.2.0

### Breaking changes

- **Worker deployments from the repo template.** `wrangler.jsonc` now sets `main` to
  `src/live-worker.ts` and binds the `SYNC_ROOM` Durable Object, with the `v1` migration
  (`new_sqlite_classes`). A deployment made from the 0.1.0 template has neither. Add both before you
  deploy 0.2.0. The published package does not include `wrangler.jsonc`.
- **Token table.** An `AGENTIC_DOCS_TOKENS` entry in object form may now carry a `role`. A `role` that
  is not `editor` or `viewer` refuses the whole token table, so a typo never leaves a token live with
  the wrong role. Entries with no `role` stay editors, as before.
- **Dependencies.** `agentic-identity` moves from `^0.2.0` to `^0.3.0`. `agentic-realtime` is `^0.1.0`,
  the version on npm.

### Added

- Live rooms. Several people and agents edit one document at the same time. Import `LiveDoc` from
  `agentic-documents/live`. Deploy `agentic-documents/live-worker` to host the rooms.
- `--live <url>` on the CLI and the MCP server, or `AGENTIC_DOCS_LIVE_URL`. Set `AGENTIC_DOCS_TOKEN`
  to join a room. The server sets the author kind and the role from the token.
- A `viewer` role. A viewer reads and cannot write, over HTTP or in a live room. The default role is
  `editor`.
- Worker routes for live rooms: `GET /api/v1/me`, `GET /api/v1/docs/:id/room`,
  `GET /api/v1/docs/:id/ws`, `GET /api/v1/docs/:id/state`, and `POST /api/v1/docs/:id/checkpoint`.
- Live rooms save through the shared `Store` and `Blobs` ports. A stored document too big for a room
  fails the join with a clear error.
- `npm pack` and `npm publish` build `dist/` first (`prepack`).

### Changed

- With `--live`, the CLI refuses `--as`, `--scopes`, and `--dir`, and exits 2. The server sets these
  from the token.
- `DocsService` implements a new `DocAccess` type. The commands, `createMcpServer`, and `startMcp`
  take `DocAccess`. A caller that passes a `DocsService` still compiles.

## 0.1.0

- First release. The document model, the Markdown and ODT export, the text operations, the CLI, the
  MCP server, and the Worker HTTP API.
