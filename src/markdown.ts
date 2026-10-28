import type { Definition, PhrasingContent, Root, RootContent, TableCell } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { DocError } from "./errors.js";
import { gfm } from "micromark-extension-gfm";

/** A ProseMirror node in JSON form, the shape y-prosemirror reads and writes. */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

type Mark = NonNullable<PmNode["marks"]>[number];

// Reference links and images read their URL from a definition. Set for one parse, which is synchronous.
let definitions = new Map<string, Definition>();

function unsupported(what: string): never {
  throw new DocError("INVALID_INPUT", `Markdown ${what} is not supported and would be lost; remove it or write it inline`);
}

function collectDefinitions(nodes: readonly { type: string }[], into: Map<string, Definition>): void {
  for (const node of nodes) {
    if (node.type === "definition") into.set((node as Definition).identifier, node as Definition);
    const children = (node as { children?: { type: string }[] }).children;
    if (children) collectDefinitions(children, into);
  }
}

const withContent = (node: PmNode, content: PmNode[]): PmNode => (content.length ? { ...node, content } : node);

function inline(nodes: PhrasingContent[], marks: Mark[] = []): PmNode[] {
  return nodes.flatMap((node): PmNode[] => {
    const text = (value: string, own: Mark[]): PmNode[] =>
      value ? [{ type: "text", text: value, ...(own.length ? { marks: own } : {}) }] : [];
    switch (node.type) {
      case "text":
        return text(node.value, marks);
      case "html":
        return text(node.value, marks);
      case "inlineCode":
        return text(node.value, [{ type: "code" }]);
      case "strong":
        return inline(node.children, [...marks, { type: "bold" }]);
      case "emphasis":
        return inline(node.children, [...marks, { type: "italic" }]);
      case "delete":
        return inline(node.children, [...marks, { type: "strike" }]);
      case "link":
        return inline(node.children, [...marks, { type: "link", attrs: { href: node.url } }]);
      case "image":
        return [{ type: "image", attrs: { src: node.url, alt: node.alt ?? null, title: node.title ?? null } }];
      case "break":
        return [{ type: "hardBreak" }];
      case "linkReference":
        return inline(node.children, [...marks, { type: "link", attrs: { href: definitions.get(node.identifier)?.url ?? unsupported("link reference without a definition") } }]);
      case "imageReference": {
        const url = definitions.get(node.identifier)?.url ?? unsupported("image reference without a definition");
        return [{ type: "image", attrs: { src: url, alt: node.alt ?? null, title: null } }];
      }
      default:
        return unsupported(`"${node.type}"`);
    }
  });
}

function itemContent(children: RootContent[]): PmNode[] {
  const content = blocks(children);
  return content[0]?.type === "paragraph" ? content : [{ type: "paragraph" }, ...content];
}

function cell(type: string, node: TableCell): PmNode {
  return { type, content: [withContent({ type: "paragraph" }, inline(node.children))] };
}

function blocks(nodes: RootContent[]): PmNode[] {
  return nodes.flatMap((node): PmNode[] => {
    switch (node.type) {
      case "heading":
        return [withContent({ type: "heading", attrs: { level: node.depth } }, inline(node.children))];
      case "paragraph":
        return [withContent({ type: "paragraph" }, inline(node.children))];
      case "html":
        return [withContent({ type: "paragraph" }, inline([node]))];
      case "blockquote":
        return [{ type: "blockquote", content: blocks(node.children) }];
      case "code":
        return [withContent({ type: "codeBlock", attrs: { language: node.lang ?? null } }, node.value ? [{ type: "text", text: node.value }] : [])];
      case "thematicBreak":
        return [{ type: "horizontalRule" }];
      case "list": {
        const task = node.children.some((item) => item.checked != null);
        const items = node.children.map(
          (item): PmNode => ({
            type: task ? "taskItem" : "listItem",
            ...(task ? { attrs: { checked: item.checked === true } } : {}),
            content: itemContent(item.children),
          }),
        );
        if (task) return [{ type: "taskList", content: items }];
        return node.ordered
          ? [{ type: "orderedList", attrs: { start: node.start ?? 1 }, content: items }]
          : [{ type: "bulletList", content: items }];
      }
      case "table":
        return [
          {
            type: "table",
            content: node.children.map((row, i) => ({
              type: "tableRow",
              content: row.children.map((c) => cell(i === 0 ? "tableHeader" : "tableCell", c)),
            })),
          },
        ];
      case "definition":
        return [];
      default:
        return unsupported(`"${node.type}"`);
    }
  });
}

/** Parse GitHub-flavored Markdown into top-level ProseMirror blocks. */
export function markdownToBlocks(markdown: string): PmNode[] {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  definitions = new Map();
  collectDefinitions(tree.children, definitions);
  let out: PmNode[];
  try {
    out = blocks(tree.children);
  } finally {
    definitions = new Map();
  }
  return out.length ? out : [{ type: "paragraph" }];
}

const MARK_ORDER = ["link", "bold", "italic", "strike", "code"];

function leaf(node: PmNode): PhrasingContent {
  if (node.type === "image") {
    return { type: "image", url: String(node.attrs?.src ?? ""), alt: (node.attrs?.alt as string) ?? null, title: (node.attrs?.title as string) ?? null };
  }
  if (node.type === "hardBreak") return { type: "break" };
  return { type: "text", value: node.text ?? "" };
}

function wrap(nodes: PmNode[], depth: number): PhrasingContent[] {
  if (depth === MARK_ORDER.length) return nodes.map(leaf);
  const name = MARK_ORDER[depth];
  const find = (node: PmNode) => node.marks?.find((m) => m.type === name);
  const out: PhrasingContent[] = [];
  for (let i = 0; i < nodes.length; ) {
    const mark = find(nodes[i]);
    let j = i + 1;
    while (j < nodes.length && JSON.stringify(find(nodes[j])?.attrs?.href) === JSON.stringify(mark?.attrs?.href) && !!find(nodes[j]) === !!mark) j++;
    const run = nodes.slice(i, j);
    i = j;
    if (!mark) out.push(...wrap(run, depth + 1));
    else if (name === "code") out.push({ type: "inlineCode", value: run.map((n) => n.text ?? "").join("") });
    else {
      const children = wrap(run, depth + 1);
      if (name === "link") out.push({ type: "link", url: String(mark.attrs?.href ?? ""), children });
      else out.push({ type: name === "bold" ? "strong" : name === "italic" ? "emphasis" : "delete", children });
    }
  }
  return out;
}

// Edge whitespace has no Markdown form that survives a round trip, so drop it.
function phrasing(node: PmNode): PhrasingContent[] {
  const nodes = [...(node.content ?? [])];
  const first = nodes[0];
  if (first?.type === "text") nodes[0] = { ...first, text: first.text?.trimStart() };
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") nodes[nodes.length - 1] = { ...last, text: last.text?.trimEnd() };
  return wrap(nodes.filter((n) => n.type !== "text" || n.text), 0);
}

function cellText(node: PmNode): PhrasingContent[] {
  return (node.content ?? []).flatMap((p, i) => (i ? [{ type: "break" } as PhrasingContent, ...phrasing(p)] : phrasing(p)));
}

function blocksOut(nodes: PmNode[]): RootContent[] {
  return nodes.flatMap((node): RootContent[] => {
    const children = node.content ?? [];
    switch (node.type) {
      case "paragraph":
        return children.length ? [{ type: "paragraph", children: phrasing(node) }] : [];
      case "heading":
        return [{ type: "heading", depth: Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))) as 1, children: phrasing(node) }];
      case "blockquote":
        return [{ type: "blockquote", children: blocksOut(children) as never }];
      case "codeBlock":
        return [{ type: "code", lang: (node.attrs?.language as string) ?? null, value: children.map((c) => c.text ?? "").join("") }];
      case "horizontalRule":
        return [{ type: "thematicBreak" }];
      case "bulletList":
      case "orderedList":
      case "taskList": {
        const task = node.type === "taskList";
        return [
          {
            type: "list",
            ordered: node.type === "orderedList",
            start: node.type === "orderedList" ? Number(node.attrs?.start ?? 1) : null,
            spread: false,
            children: children.map((item) => ({
              type: "listItem" as const,
              spread: false,
              ...(task ? { checked: item.attrs?.checked === true } : {}),
              children: blocksOut(item.content ?? []) as never,
            })),
          },
        ];
      }
      case "table":
        return [
          {
            type: "table",
            children: children.map((row) => ({
              type: "tableRow" as const,
              children: (row.content ?? []).map((c) => ({ type: "tableCell" as const, children: cellText(c) })),
            })),
          },
        ];
      default:
        return [];
    }
  });
}

/** Serialize top-level ProseMirror blocks to GitHub-flavored Markdown. */
export function blocksToMarkdown(nodes: PmNode[]): string {
  const root: Root = { type: "root", children: blocksOut(nodes) };
  return toMarkdown(root, { extensions: [gfmToMarkdown()], bullet: "-", rule: "-", fences: true, emphasis: "*", strong: "*" });
}
