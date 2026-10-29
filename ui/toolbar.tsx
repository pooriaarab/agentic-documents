// The formatting toolbar. Ported from the gitmarkdown editor toolbar (MIT, see THIRD_PARTY_NOTICES.md), on the
// agentic-design toolbar: one tab stop, arrow keys move between the buttons.
import type { Editor } from "@tiptap/core";
import { selectedRect } from "@tiptap/pm/tables";
import { Menu, Toolbar, ToolbarButton, ToolbarGroup, type MenuItem } from "agentic-design/react";
import type { ReactNode } from "react";
import { LANGUAGES, languageId, languageName } from "./code.js";
import { glyph, icons } from "./icons.js";

/** The text styles of a block, in the order the menu shows them. */
const STYLES = [
  { name: "Paragraph", short: "P", active: (e: Editor) => e.isActive("paragraph"), run: (e: Editor) => e.chain().focus().setParagraph().run() },
  ...([1, 2, 3] as const).map((level) => ({
    name: `Heading ${level}`,
    short: `H${level}`,
    active: (e: Editor) => e.isActive("heading", { level }),
    run: (e: Editor) => e.chain().focus().setHeading({ level }).run(),
  })),
];

export interface FormatBarProps {
  editor: Editor;
  editable: boolean;
  onLink: () => void;
  onImage: () => void;
}

export function FormatBar({ editor, editable, onLink, onImage }: FormatBarProps) {
  // Focus the view first, in this frame. The focus command moves focus in a later frame, so a key typed right after a
  // toolbar click would go to the button and be lost.
  const chain = () => (editor.view.focus(), editor.chain().focus());
  const tool = (label: string, icon: ReactNode, run: () => void, active?: boolean, disabled = false) => (
    <ToolbarButton label={label} icon={icon} pressed={active} onClick={run} disabled={!editable || disabled} />
  );
  const on = (name: string, attrs?: object) => editor.isActive(name, attrs);
  // A block that is not a paragraph or a heading, such as a code block, or a selection over several kinds, is "Other".
  const style = STYLES.find((s) => s.active(editor));
  // In a table, the Table tool opens the table changes. Elsewhere it puts in a new table. Markdown makes the first row
  // the header, so in the header row there is no row above it to add, and the row is not deleted.
  // The rows and columns the selection covers: a cell selection can span the header row and the rows under it.
  const rect = on("table") ? selectedRect(editor.state) : undefined;
  const header = rect?.top === 0;
  const oneColumn = rect?.map.width === 1;
  const tables: MenuItem[] = [
    ...(header ? [] : [{ label: "Add row above", onSelect: () => chain().addRowBefore().run() }]),
    { label: "Add row below", onSelect: () => chain().addRowAfter().run() },
    { label: "Add column before", onSelect: () => chain().addColumnBefore().run() },
    { label: "Add column after", onSelect: () => chain().addColumnAfter().run() },
    "separator",
    ...(header ? [] : [{ label: "Delete row", onSelect: () => chain().deleteRow().run() }]),
    // The last column is not deleted on its own: Delete table does that.
    ...(oneColumn ? [] : [{ label: "Delete column", onSelect: () => chain().deleteColumn().run() }]),
    "separator",
    { label: "Delete table", danger: true, onSelect: () => chain().deleteTable().run() },
  ];
  const language = editor.getAttributes("codeBlock").language as string | null | undefined;
  const languages: MenuItem[] = [["", "Plain text"] as const, ...LANGUAGES].map(([id, name]) => ({
    label: languageId(language) === id ? `${name} (in use)` : name,
    onSelect: () => chain().updateAttributes("codeBlock", { language: id || null }).run(),
  }));
  const styles: MenuItem[] = STYLES.map((s) => ({ label: s.name, icon: glyph(s.short), onSelect: () => (editor.view.focus(), s.run(editor)) }));

  return (
    <Toolbar label="Formatting">
      <Menu trigger={<ToolbarButton label={`Text style: ${style?.name ?? "Other"}`} icon={<span className="agd-style">{glyph(style?.name ?? "Other")}{icons.chevronDown}</span>} className="agd-style-button" disabled={!editable} />} items={styles} />
      <ToolbarGroup label="Text">
        {tool("Bold", glyph("B", "b"), () => chain().toggleBold().run(), on("bold"))}
        {tool("Italic", glyph("I", "i"), () => chain().toggleItalic().run(), on("italic"))}
        {tool("Strikethrough", glyph("S", "s"), () => chain().toggleStrike().run(), on("strike"))}
        {tool("Inline code", glyph("</>", "mono"), () => chain().toggleCode().run(), on("code"))}
        {tool("Link", icons.link, onLink, on("link"))}
      </ToolbarGroup>
      <ToolbarGroup label="Lists">
        {tool("Bulleted list", icons.bulletList, () => chain().toggleBulletList().run(), on("bulletList"))}
        {tool("Numbered list", icons.orderedList, () => chain().toggleOrderedList().run(), on("orderedList"))}
        {tool("Task list", icons.taskList, () => chain().toggleTaskList().run(), on("taskList"))}
      </ToolbarGroup>
      <ToolbarGroup label="Blocks">
        {tool("Quote", icons.quote, () => chain().toggleBlockquote().run(), on("blockquote"))}
        {tool("Code block", icons.codeBlock, () => chain().toggleCodeBlock().run(), on("codeBlock"))}
        {on("codeBlock") && (
          <Menu trigger={<ToolbarButton label={`Code language: ${languageName(language)}`} icon={<span className="agd-style">{glyph(languageName(language))}{icons.chevronDown}</span>} className="agd-style-button" disabled={!editable} />} items={languages} />
        )}
        {tool("Divider", icons.divider, () => chain().setHorizontalRule().run())}
        {on("table") ? (
          <Menu trigger={<ToolbarButton label="Table changes" icon={<>{icons.table}{icons.chevronDown}</>} pressed className="agd-style-button" disabled={!editable} />} items={tables} />
        ) : (
          tool("Table", icons.table, () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())
        )}
        {tool("Image", icons.image, onImage)}
      </ToolbarGroup>
      <ToolbarGroup label="History">
        {tool("Undo", icons.undo, () => chain().undo().run(), undefined, !editor.can().undo())}
        {tool("Redo", icons.redo, () => chain().redo().run(), undefined, !editor.can().redo())}
      </ToolbarGroup>
    </Toolbar>
  );
}
