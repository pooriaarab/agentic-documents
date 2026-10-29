// The slash menu: type / at the start of a line or after a space, then a word, to put in a block. Ported from the
// gitmarkdown slash command menu (MIT, see THIRD_PARTY_NOTICES.md). The text keeps the focus. The menu is a list box that
// the text controls: arrow keys move the active item, Enter or Tab picks it, Escape closes it.
import type { Editor } from "@tiptap/core";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { glyph, icons } from "./icons.js";

/** One item of the slash menu. */
export interface SlashItem {
  title: string;
  description: string;
  /** More words that find the item. */
  keywords?: string[];
  icon?: ReactNode;
  /** Runs after the slash and the typed word are gone from the text. */
  run: (editor: Editor) => void;
}

/** The blocks the menu offers. `image` opens the image dialog. */
export function defaultSlashItems({ image }: { image: () => void }): SlashItem[] {
  const c = (e: Editor) => e.chain().focus();
  return [
    { title: "Text", description: "A plain paragraph", keywords: ["paragraph"], icon: glyph("P"), run: (e) => c(e).setParagraph().run() },
    ...([1, 2, 3] as const).map((level) => ({ title: `Heading ${level}`, description: ["Large", "Medium", "Small"][level - 1] + " section heading", keywords: [`h${level}`, "title"], icon: glyph(`H${level}`), run: (e: Editor) => c(e).setHeading({ level }).run() })),
    { title: "Bulleted list", description: "A simple list", keywords: ["ul", "bullet"], icon: icons.bulletList, run: (e) => c(e).toggleBulletList().run() },
    { title: "Numbered list", description: "A list with numbers", keywords: ["ol", "ordered"], icon: icons.orderedList, run: (e) => c(e).toggleOrderedList().run() },
    { title: "Task list", description: "A list with check boxes", keywords: ["todo", "check"], icon: icons.taskList, run: (e) => c(e).toggleTaskList().run() },
    { title: "Quote", description: "A quoted passage", keywords: ["blockquote"], icon: icons.quote, run: (e) => c(e).toggleBlockquote().run() },
    { title: "Code block", description: "Code in a fixed-width font", keywords: ["pre", "snippet"], icon: icons.codeBlock, run: (e) => c(e).toggleCodeBlock().run() },
    { title: "Divider", description: "A line between parts", keywords: ["hr", "rule", "line"], icon: icons.divider, run: (e) => c(e).setHorizontalRule().run() },
    { title: "Table", description: "A table of 3 by 3 cells", keywords: ["grid"], icon: icons.table, run: (e) => c(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: "Image", description: "A picture, with alt text", keywords: ["picture", "photo"], icon: icons.image, run: () => image() },
  ];
}

/** The root font size the person chose, in px. The menu sizes in editor.css are in rem. */
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

const matches = (item: SlashItem, query: string) => [item.title, item.description, ...(item.keywords ?? [])].some((w) => w.toLowerCase().includes(query));

interface Open {
  /** The document position of the slash. */
  from: number;
  query: string;
  top: number;
  left: number;
  /** How many items fit in the window. The menu shows that many around the active one. */
  rows: number;
}

/** The slash, and the word after it, just before the caret, in a text block that is not code. */
function find(editor: Editor): Omit<Open, "top" | "left" | "rows"> | undefined {
  const { selection } = editor.state;
  if (!selection.empty || !editor.isEditable) return undefined;
  const $from = selection.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return undefined;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const found = /(?:^|\s)\/([\p{L}\p{N} ]{0,24})$/u.exec(before);
  if (!found || found[1]!.startsWith(" ")) return undefined;
  return { from: selection.from - found[1]!.length - 1, query: found[1]!.toLowerCase().trim() };
}

export function SlashMenu({ editor, items }: { editor: Editor; items: SlashItem[] }) {
  const [open, setOpen] = useState<Open>();
  const [active, setActive] = useState(0);
  // Escape closes the menu for the slash at the caret. It stays closed until the caret is no longer after a slash, so
  // typing on, or a peer writing before it, does not open it again. A position would not do: a peer's change can move it.
  const dismissed = useRef(false);
  const id = useId();
  const shown = open ? items.filter((item) => matches(item, open.query)) : [];
  const state = useRef({ open, shown, active });
  state.current = { open, shown, active };

  useEffect(() => {
    const update = () => {
      const hit = editor.isFocused ? find(editor) : undefined;
      if (!hit && editor.isFocused) dismissed.current = false; // that slash is gone, so a new one opens the menu
      if (!hit || dismissed.current) return setOpen(undefined);
      const at = editor.view.coordsAtPos(hit.from);
      setOpen((old) => {
        if (old?.query !== hit.query) setActive(0);
        // Below the slash, or above it when there is more room there. A list longer than the room shows a window of it.
        const count = items.filter((item) => matches(item, hit.query)).length;
        const below = window.innerHeight - at.bottom - 16;
        const above = at.top - 16;
        const room = Math.max(below, above);
        const rem = remPx();
        const row = 2.5 * rem; // .agd-menu__item
        const frame = 0.5 * rem + 2; // the padding and the border of .agd-menu
        const width = Math.min(18 * rem, window.innerWidth - rem);
        const rows = Math.max(3, Math.min(count, Math.floor((room - frame - row / 2) / row)));
        const height = Math.min(count, rows) * row + frame + (rows < count ? row / 2 : 0);
        const top = height <= below || below >= above ? at.bottom + 4 : at.top - 4 - height;
        return { ...hit, rows, top, left: Math.max(8, Math.min(at.left, window.innerWidth - width - 8)) };
      });
    };
    const blur = () => setOpen(undefined);
    editor.on("update", update);
    editor.on("selectionUpdate", update);
    editor.on("blur", blur);
    window.addEventListener("scroll", update, true); // the menu stays under the slash
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      editor.off("update", update);
      editor.off("selectionUpdate", update);
      editor.off("blur", blur);
    };
  }, [editor, items]);

  const pick = (item: SlashItem) => {
    const { open: at } = state.current;
    if (!at) return;
    setOpen(undefined);
    editor.chain().focus().deleteRange({ from: at.from, to: editor.state.selection.from }).run();
    item.run(editor);
  };

  // The text keeps the focus, so it tells assistive technology which item is active. The keys are read before the
  // editor reads them.
  useEffect(() => {
    const dom = editor.view.dom;
    const listbox = `${id}-list`;
    if (open && shown.length > 0) {
      dom.setAttribute("aria-controls", listbox);
      dom.setAttribute("aria-activedescendant", `${id}-${Math.min(active, shown.length - 1)}`);
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
    const keys = (event: KeyboardEvent) => {
      const { open: at, shown: list, active: index } = state.current;
      if (!at || list.length === 0 || event.isComposing) return;
      const move = (to: number) => (event.preventDefault(), event.stopPropagation(), setActive((to + list.length) % list.length));
      if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp") move(index - 1);
      else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        pick(list[Math.min(index, list.length - 1)]!);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissed.current = true;
        setOpen(undefined);
      }
    };
    dom.addEventListener("keydown", keys, true);
    return () => dom.removeEventListener("keydown", keys, true);
  });

  if (!open || shown.length === 0) return null;
  const current = Math.min(active, shown.length - 1);
  const first = Math.max(0, Math.min(current - Math.floor(open.rows / 2), shown.length - open.rows));
  return (
    <div className="agd-menu agd-slash" style={{ top: open.top, left: open.left }}>
      <ul role="listbox" id={`${id}-list`} aria-label="Insert a block">
        {shown.map((item, index) => index >= first && index < first + open.rows && (
          <li
            key={item.title}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === current}
            aria-posinset={index + 1}
            aria-setsize={shown.length}
            className="agd-menu__item"
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => pick(item)}
          >
            <span className="agd-menu__icon" aria-hidden="true">{item.icon}</span>
            <span className="agd-menu__words">
              <span>{item.title}</span>
              <small>{item.description}</small>
            </span>
          </li>
        ))}
      </ul>
      {open.rows < shown.length && <p className="agd-menu__more" aria-hidden="true">{shown.length - open.rows} more: use the arrow keys</p>}
    </div>
  );
}
