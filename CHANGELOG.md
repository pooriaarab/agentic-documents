# Changelog

## 0.3.0

### Breaking changes

- **Dependencies.** `agentic-identity` moves from `^0.3.0` to `^0.4.0`. In 0.4 a grant is keyed on the
  principal kind and the id, so a person and an agent with the same id hold separate roles. Grants
  written by 0.3 are not honored until you run `migrateGrants`. A host that shares documents through
  `createSharing` must pass `{ kind, id }` to `grant` and `revokeGrant`.

### Added

- Tests that a person and an agent with the same id get separate roles, and that `deleteResource`
  removes the grants. This package has no grant call and no delete command of its own. A host that
  deletes a document or erases a person must call `deleteResource` for it.

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
