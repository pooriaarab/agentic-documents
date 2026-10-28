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
| `doc.outline()` | List sections: `id`, `level`, `title`. |
| `doc.readSection(id)` | Read one section. |
| `doc.insert / replace / delete(target, ...)` | Change a section or matched text. |
| `doc.append(md, author)` | Add blocks at the end. |
| `doc.anchor(text, occurrence?)` | Pin a text range for later. |
| `doc.edits()` | Read the edit log. |

A target is `{ section }`, `{ text, occurrence? }`, or `{ anchor }`.

## The loop

1. Read the outline.
2. Read the section you plan to change.
3. Change it by section id. Use exact text for a small edit.
4. Read the section again and check the result.

## Rules

- Pass your own author kind and name on every change.
- On `AMBIGUOUS_MATCH`, read the contexts and pass `occurrence`. Do not guess.
- On `STALE_ANCHOR` or `NO_MATCH`, read the document again. Then decide.
- A section replace keeps the heading and removes the subsections.
- Report errors as errors. Never present them as success.
