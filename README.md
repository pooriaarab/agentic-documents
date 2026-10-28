# agentic-documents

[![npm version](https://img.shields.io/npm/v/agentic-documents)](https://www.npmjs.com/package/agentic-documents)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-documents) · [Source](https://github.com/pooriaarab/agentic-documents) · [Support](https://github.com/pooriaarab/agentic-documents/issues)

Write documents with people and agents in real time.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- A rich-text editor with headings, lists, tables, images, and code.
- Real-time editing with live cursors.
- Comments and suggested edits, from people or agents.
- Agent tools: read, insert, replace, and suggest by section or text match.
- Import and export Markdown, HTML, and DOCX.
- Share by invite or link, with roles.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-documents"`.
- **CLI**: `npx agentic-documents --help`.
- **MCP server**: `npx agentic-documents mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
