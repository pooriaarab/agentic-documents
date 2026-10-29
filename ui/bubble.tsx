// The bubble menu: formatting tools over a text selection. Ported from the gitmarkdown bubble menu (MIT, see
// THIRD_PARTY_NOTICES.md). Alt+F10 moves the focus into it, and Escape gives the focus back to the text.
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { Toolbar, ToolbarButton } from "agentic-design/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { glyph, icons } from "./icons.js";

/** A tool that an app adds to the bubble menu with the `bubbleActions` option, such as Comment or Rewrite. */
export interface BubbleAction {
  label: string;
  icon: ReactNode;
  /** Runs with the selection still in place. */
  run: (editor: Editor) => void;
  /** Off for a person who may not change the text, unless this is true. */
  readOnly?: boolean;
}

const GAP = 8;

/** A selection of text that the tools can format: not empty, not a picture or a cell, not code. */
const formattable = (editor: Editor) => {
  const { selection } = editor.state;
  return !selection.empty && !(selection instanceof NodeSelection) && !("$anchorCell" in selection) && !editor.isActive("codeBlock");
};

export function BubbleMenu({ editor, editable, onLink, actions = [] }: { editor: Editor; editable: boolean; onLink: () => void; actions?: BubbleAction[] }) {
  const [at, setAt] = useState<{ top: number; left: number }>();
  const box = useRef<HTMLDivElement>(null);
  const tools = actions.filter((a) => editable || a.readOnly);

  useEffect(() => {
    const place = () => {
      if (!formattable(editor) || (!editor.isFocused && !box.current?.contains(document.activeElement))) return setAt(undefined);
      const { from, to } = editor.state.selection;
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const width = box.current?.offsetWidth ?? 240;
      const height = box.current?.offsetHeight ?? 40;
      const left = Math.max(8, Math.min((start.left + end.right) / 2 - width / 2, window.innerWidth - width - 8));
      const above = start.top - height - GAP;
      setAt({ top: above < 56 ? end.bottom + GAP : above, left }); // below the selection when the bar is in the way
    };
    const blur = ({ event }: { event: FocusEvent }) => {
      if (!box.current?.contains(event.relatedTarget as Node | null)) setAt(undefined);
    };
    const later = () => requestAnimationFrame(place);
    editor.on("selectionUpdate", later);
    editor.on("focus", later);
    editor.on("blur", blur);
    window.addEventListener("scroll", later, true);
    window.addEventListener("resize", later);
    const keys = (event: KeyboardEvent) => {
      if (event.key === "F10" && event.altKey && box.current) {
        event.preventDefault();
        box.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      }
    };
    const dom = editor.view.dom; // read now: the editor may be gone when this cleans up
    dom.addEventListener("keydown", keys);
    return () => {
      editor.off("selectionUpdate", later);
      editor.off("focus", later);
      editor.off("blur", blur);
      window.removeEventListener("scroll", later, true);
      window.removeEventListener("resize", later);
      dom.removeEventListener("keydown", keys);
    };
  }, [editor]);

  if (!at || (!editable && tools.length === 0)) return null;
  const back = () => editor.view.focus();
  const tool = (label: string, icon: ReactNode, run: () => void, active?: boolean) => (
    <ToolbarButton label={label} icon={icon} pressed={active} onClick={() => (back(), run())} />
  );
  const chain = () => editor.chain().focus();
  return (
    <div
      ref={box}
      className="agd-bubble"
      style={{ top: at.top, left: at.left }}
      onMouseDown={(e) => e.preventDefault()} // a click keeps the selection
      onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), back())}
      onBlur={(e) => !box.current?.contains(e.relatedTarget as Node | null) && e.relatedTarget !== editor.view.dom && setAt(undefined)}
    >
      <Toolbar label="Selection">
        {editable && (
          <>
            {tool("Bold", glyph("B", "b"), () => chain().toggleBold().run(), editor.isActive("bold"))}
            {tool("Italic", glyph("I", "i"), () => chain().toggleItalic().run(), editor.isActive("italic"))}
            {tool("Strikethrough", glyph("S", "s"), () => chain().toggleStrike().run(), editor.isActive("strike"))}
            {tool("Inline code", glyph("</>", "mono"), () => chain().toggleCode().run(), editor.isActive("code"))}
            {tool("Link", icons.link, onLink, editor.isActive("link"))}
          </>
        )}
        {tools.map((a) => <ToolbarButton key={a.label} label={a.label} icon={a.icon} onClick={() => a.run(editor)} />)}
      </Toolbar>
    </div>
  );
}
