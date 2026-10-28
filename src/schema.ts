import { Schema, type MarkSpec, type NodeSpec } from "prosemirror-model";

// Node and mark names and attributes follow the Tiptap defaults, so a Tiptap
// editor can open a document stored in Yjs by y-prosemirror without a mapper.
const cell: NodeSpec = {
  content: "block+",
  attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } },
};

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },
  paragraph: { group: "block", content: "inline*" },
  text: { group: "inline" },
  heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } } },
  blockquote: { group: "block", content: "block+" },
  codeBlock: { group: "block", content: "text*", marks: "", code: true, attrs: { language: { default: null } } },
  horizontalRule: { group: "block" },
  bulletList: { group: "block", content: "listItem+" },
  orderedList: { group: "block", content: "listItem+", attrs: { start: { default: 1 }, type: { default: null } } },
  listItem: { content: "paragraph block*" },
  taskList: { group: "block", content: "taskItem+" },
  taskItem: { content: "paragraph block*", attrs: { checked: { default: false } } },
  hardBreak: { group: "inline", inline: true },
  image: {
    group: "inline",
    inline: true,
    attrs: { src: { default: null }, alt: { default: null }, title: { default: null } },
  },
  table: { group: "block", content: "tableRow+" },
  tableRow: { content: "(tableCell | tableHeader)*" },
  tableCell: cell,
  tableHeader: cell,
};

const marks: Record<string, MarkSpec> = {
  bold: {},
  italic: {},
  strike: {},
  code: { excludes: "_" },
  link: {
    inclusive: false,
    attrs: {
      href: { default: null },
      target: { default: "_blank" },
      rel: { default: "noopener noreferrer nofollow" },
      class: { default: null },
    },
  },
};

export const schema = new Schema({ nodes, marks });
