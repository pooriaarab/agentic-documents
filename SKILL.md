---
name: agentic-documents
description: Write documents with people and agents in real time. Keywords: documents,editor,rich-text,tiptap,collaboration,agents,mcp,cli,cloudflare.
---

# agentic-documents

Write documents with people and agents in real time.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-documents";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-documents summary --text "some text"
agentic-documents dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-documents mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
