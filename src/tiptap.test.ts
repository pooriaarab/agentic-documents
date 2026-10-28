// Contract: a stock Tiptap editor schema opens a document stored by this package.
import { getSchema } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import StarterKit from "@tiptap/starter-kit";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { expect, test } from "vitest";
import { AgenticDoc } from "./index.js";

const tiptap = getSchema([
  StarterKit,
  Image.configure({ inline: true }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableCell,
  TableHeader,
]);

const MD = "# T\n\n*a* **b** ~~c~~ `d` [e](https://x.org)\n\n- [x] t\n\n1. o\n\n> q\n\n```js\nx\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![i](https://x.org/i.png)\n\n---\n";

test("Tiptap reads our fragment as a valid document", () => {
  const doc = AgenticDoc.fromMarkdown(MD, { kind: "human", name: "Ada" });
  const root = yXmlFragmentToProseMirrorRootNode(doc.ydoc.getXmlFragment("default"), tiptap);
  expect(() => root.check()).not.toThrow();
  expect(root.childCount).toBe(doc.toJSON().content?.length);
});
