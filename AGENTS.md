# agentic-documents agent guide

Write documents with people and agents in real time.

## Mental model

A document is a Yjs fragment in the Tiptap layout. You read it as Markdown. You
change it by section id or by exact text. Every change needs an author.

## Use it

```ts
import { AgenticDoc } from "agentic-documents";
```

| Call | Use it for |
| --- | --- |
| `AgenticDoc.fromMarkdown(md, author)` | Make a document. |
| `doc.toMarkdown()` | Read the whole document. |
| `doc.outline()` | List sections: `id`, `level`, `title`. The `preamble` section (level 0) holds text before the first heading. |
| `doc.readSection(id)` | Read one section. |
| `doc.insert / replace / delete(target, ...)` | Change a section or matched text. |
| `doc.append(md, author)` | Add blocks at the end. |
| `doc.anchor(text, occurrence?)` | Pin a text range for later. |
| `doc.edits()` | Read the edit log. |
| `new Threads(doc)` | `add`, `reply`, `resolve`, `reopen`, `list`. |
| `new Suggestions(doc)` | `add`, `accept`, `reject`, `list`. |

A target is `{ section }`, `{ text, occurrence? }`, or `{ anchor }`.

## CLI and MCP

The CLI and the MCP server share one command table. A tool is `doc_<command>`. Start the server
with `npx agentic-documents mcp --as <kind>:<name>`. The operator sets your author. You cannot
change it in a call.

| Tool | Use it for |
| --- | --- |
| `doc_new`, `doc_list`, `doc_read`, `doc_outline`, `doc_edits` | Create, list, and read. |
| `doc_rename`, `doc_remove` | Title a document, or delete it. An agent needs the `docs:remove` scope to remove. |
| `doc_insert`, `doc_replace`, `doc_delete`, `doc_append` | Change text or sections. |
| `doc_suggest`, `doc_suggestions`, `doc_accept`, `doc_reject` | Suggested edits. |
| `doc_comment`, `doc_reply`, `doc_resolve`, `doc_reopen`, `doc_threads` | Comment threads. |
| `doc_grants`, `doc_grant`, `doc_revoke` | List, give, and take away a role (`viewer`, `commenter`, `editor`, `owner`). `to` is `human:<id>` or `agent:<id>`. |
| `doc_invites`, `doc_invite` | List invites. Invite by `email`, or an agent by `handle`. |
| `doc_link`, `doc_unlink` | Make a share link token (it shows once), or revoke a link by id. |
| `doc_export` | Export as `md`, `html`, or `odt` (base64 file). |

Only an owner shares a document. Over HTTP every caller needs the `docs:admin` scope. In local mode, an agent needs it in the CLI and the MCP server too. A refusal is `FORBIDDEN`. Never try to
grant yourself a role. Roles are stored, but reads and writes do not check them yet, nothing opens a link token, and
nothing accepts an invite. A `revoke` does not stop a token that has its own `editor` role. A document with no owner record (made before sharing, or by an author with no `docs:write` scope) is claimed by its creator, when the caller is that creator and has a write scope. A document with no creator in the catalog, one whose author name is not a valid grant name, or one made by an agent that acts for a person, cannot be claimed. A rename can record a creator for one with no creator.

An error returns `isError` with `{ error: { code, message, matches } }`.

## Live rooms

Add `--live <url>` to the CLI or the MCP server, and set `AGENTIC_DOCS_TOKEN`. Or set `AGENTIC_DOCS_LIVE_URL`. Every command except `new`, `list`, `rename`, `remove`, and the sharing commands (`grants`, `grant`, `revoke`, `invites`, `invite`, `link`, `unlink`) then runs in
the live room for that document and saves to the stored document (those go to the store through the HTTP API). The server sets your author kind and your
role from the token, so `--as`, `--scopes`, and `--dir` are refused. A `viewer` token gets `FORBIDDEN` on every change. In the SDK,
`LiveDoc.join({ server, id, token })` gives you `edit`, `save`, `peers`, and `leave`. The Worker also has two routes that are not commands: `GET /api/v1/docs/:id/state` (the stored document as a Yjs update) and `POST /api/v1/docs/:id/checkpoint` (merge a room into it; it makes a missing document, unless you add `?create=false`, which fails with `NO_DOCUMENT`).

## HTTP API

The Worker mirrors each command: `GET /api/v1/docs/:id/<command>` for reads, `POST` for writes,
and `POST /api/v1/docs` for `new`. Send `authorization: Bearer <token>`. The token sets your author.

## The loop

1. Read the outline.
2. Read the section you plan to change.
3. Change it by section id. Use exact text for a small edit.
4. Read the section again and check the result.

## Rules

- Pass your own author kind and name on every change.
- On `AMBIGUOUS_MATCH`, read the contexts and pass `occurrence`. Do not guess.
- On `STALE_ANCHOR` or `NO_MATCH`, read the document again. Then decide.
- Prefer a suggestion over a direct edit when a person owns the text.
- Only a person accepts a suggestion, or an agent that holds the `docs:accept` scope. Never accept or reject your own. `FORBIDDEN` means you may not.
- A stale suggestion stays pending. Reject it or make a new one.
- A section replace keeps the heading and removes the subsections. Text before the first heading is the `preamble` section (level 0, id `preamble`).
- Report errors as errors. Never present them as success.
