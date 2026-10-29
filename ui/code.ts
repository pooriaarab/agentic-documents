// Code blocks with a language and syntax colors, as in the gitmarkdown editor (MIT, see THIRD_PARTY_NOTICES.md). Only
// the languages below are bundled, to keep the page small. The colors are decorations: the stored text has no marks.
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

/** The languages a code block offers: the name a Markdown fence uses, and the name a person reads. */
export const LANGUAGES: [id: string, name: string][] = [
  ["bash", "Shell"],
  ["css", "CSS"],
  ["go", "Go"],
  ["html", "HTML"],
  ["javascript", "JavaScript"],
  ["json", "JSON"],
  ["markdown", "Markdown"],
  ["python", "Python"],
  ["rust", "Rust"],
  ["sql", "SQL"],
  ["typescript", "TypeScript"],
  ["yaml", "YAML"],
];

const lowlight = createLowlight({ bash, css, go, javascript, json, markdown, plaintext, python, rust, sql, typescript, xml, yaml });
lowlight.registerAlias({ xml: ["html"], bash: ["sh", "shell"], javascript: ["js"], typescript: ["ts"], python: ["py"], yaml: ["yml"] });

/** The name of a code block language, or the fence name itself for a language the menu does not list. */
export const languageName = (id: string | null | undefined): string => (id ? (LANGUAGES.find(([key]) => key === id)?.[1] ?? id) : "Plain text");

// A block with no language is plain text. It is not guessed, so its colors do not change while a person types. The
// stored language stays empty: `defaultLanguage` alone would also store "plaintext" in each new block.
export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    const parent: Record<string, object> = this.parent?.() ?? {};
    return { ...parent, language: { ...parent.language, default: null } };
  },
}).configure({ lowlight, defaultLanguage: "plaintext" });
