// The icons of the editor. Each is a 20 by 20 line drawing in the text color, hidden from assistive technology: the
// button around it has the name.
import type { ReactNode } from "react";

const icon = (body: ReactNode) => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="1.25em" height="1.25em" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {body}
  </svg>
);

/** A word or a letter as an icon, for the marks that have a well-known letter. */
export const glyph = (text: string, style?: "b" | "i" | "s" | "mono") => <span aria-hidden="true" className={`agd-glyph agd-glyph--${style ?? "plain"}`}>{text}</span>;

export const icons = {
  bulletList: icon(<><path d="M8 5h9M8 10h9M8 15h9" /><path d="M3.5 5h.01M3.5 10h.01M3.5 15h.01" strokeWidth="2.6" /></>),
  orderedList: icon(<><path d="M8 5h9M8 10h9M8 15h9" /><path d="M3 4.5l1-.5v4M3 11.5h2l-2 2.5h2.2" /></>),
  taskList: icon(<><rect x="2.5" y="3" width="4.5" height="4.5" rx="1" /><path d="M3.6 5.3l1 1 1.6-1.9" /><rect x="2.5" y="12" width="4.5" height="4.5" rx="1" /><path d="M10 5.25h7M10 14.25h7" /></>),
  quote: icon(<><path d="M4 4v12" /><path d="M8 6h9M8 10h9M8 14h6" /></>),
  codeBlock: icon(<><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M8 8l-2 2 2 2M12 8l2 2-2 2" /></>),
  divider: icon(<><path d="M2.5 10h15" /><path d="M5 5.5h10M5 14.5h10" strokeOpacity="0.45" /></>),
  table: icon(<><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><path d="M2.5 8h15M2.5 12.25h15M7.5 8v8.5M12.5 8v8.5" /></>),
  image: icon(<><rect x="2.5" y="3.5" width="15" height="13" rx="1.5" /><circle cx="7" cy="8" r="1.4" /><path d="M3 15l4.5-4.5 3 3 2-2 4.5 4.5" /></>),
  link: icon(<><path d="M8.5 11.5a3 3 0 004.2 0l2.6-2.6a3 3 0 00-4.2-4.2l-1 1" /><path d="M11.5 8.5a3 3 0 00-4.2 0l-2.6 2.6a3 3 0 004.2 4.2l1-1" /></>),
  undo: icon(<><path d="M7 5L3.5 8.5 7 12" /><path d="M3.5 8.5H12a4.5 4.5 0 010 9H9" /></>),
  redo: icon(<><path d="M13 5l3.5 3.5L13 12" /><path d="M16.5 8.5H8a4.5 4.5 0 000 9h3" /></>),
  back: icon(<path d="M12.5 4.5L7 10l5.5 5.5" />),
  chevronDown: icon(<path d="M6 8l4 4 4-4" />),
};
