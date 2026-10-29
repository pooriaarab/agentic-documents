import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

interface Run {
  text: Y.XmlText;
  from: number;
  to: number;
}

/**
 * The text that an agent wrote. The edit log says which Yjs client each logged edit came from and the kind of its author.
 * Every piece of text carries the client id of its writer, so text from an agent client is an agent's.
 */
export function agentRuns(doc: Y.Doc): Run[] {
  const agents = new Set<number>();
  for (const entry of doc.getArray<{ author?: { kind?: string }; client?: unknown } | null>("edits").toArray()) {
    if (typeof entry !== "object" || entry === null) continue; // the room does not check the log, so skip a bad entry
    if (typeof entry.client === "number" && entry.author?.kind !== undefined && entry.author.kind !== "human") agents.add(entry.client);
  }
  const runs: Run[] = [];
  if (agents.size === 0) return runs;
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) walk(child);
      else if (child instanceof Y.XmlText) {
        let index = 0;
        for (let item = (child as unknown as { _start: Y.Item | null })._start; item; item = item.right) {
          if (item.deleted || !item.countable) continue;
          if (agents.has(item.id.client)) runs.push({ text: child, from: index, to: index + item.length });
          index += item.length;
        }
      }
    }
  };
  walk(doc.getXmlFragment("default"));
  return runs;
}

const key = new PluginKey<DecorationSet>("agentText");

/** Underlines the text an agent wrote with a dotted line, and gives it a name for assistive technology. */
export const AgentText = Extension.create({
  name: "agentText",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => (tr.getMeta(key) as DecorationSet | undefined) ?? old.map(tr.mapping, tr.doc),
        },
        props: { decorations: (state) => key.getState(state) },
        view(view) {
          const sync = ySyncPluginKey.getState(view.state) as { doc: Y.Doc; type: Y.XmlFragment; binding?: { mapping: Map<Y.AbstractType<unknown>, unknown> } } | undefined;
          if (!sync) return {};
          let timer: ReturnType<typeof setTimeout> | undefined;
          let drawn = "";
          const refresh = () => {
            timer = undefined;
            try {
              const mapping = (ySyncPluginKey.getState(view.state) as typeof sync).binding?.mapping;
              if (!mapping) return;
              const size = view.state.doc.content.size;
              const marks: Decoration[] = [];
              for (const { text, from, to } of agentRuns(sync.doc)) {
                const a = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromTypeIndex(text, from), mapping as never);
                const b = relativePositionToAbsolutePosition(sync.doc, sync.type, Y.createRelativePositionFromTypeIndex(text, to), mapping as never);
                if (a !== null && b !== null && a < b && b <= size) marks.push(Decoration.inline(a, b, { class: "agent-text", title: "Written by an agent" }));
              }
              const signature = marks.map((m) => `${m.from}-${m.to}`).join(",");
              if (signature === drawn) return; // nothing moved: no transaction, no render
              drawn = signature;
              view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, marks)).setMeta("addToHistory", false));
            } catch {
              /* the text and the document were mid-change. The next update draws again. */
            }
          };
          const schedule = () => {
            timer ??= setTimeout(refresh, 60);
          };
          sync.doc.on("update", schedule);
          schedule();
          return {
            destroy() {
              sync.doc.off("update", schedule);
              if (timer) clearTimeout(timer);
            },
          };
        },
      }),
    ];
  },
});
