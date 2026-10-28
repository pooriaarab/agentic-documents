import * as Y from "yjs";

/** What one replica did when it accepted a suggestion. The map key is `<suggestion id>:<client id>`. */
export interface Application {
  by: { kind: string; name: string };
  /** The time of the edit entry that this replica wrote. */
  at: string;
  /** Where the replica inserted text, as relative positions. Absent for a delete. */
  start?: Record<string, unknown>;
  end?: Record<string, unknown>;
}

export const APPLIED = "applied";

const clientOf = (key: string): number => Number(key.slice(key.lastIndexOf(":") + 1));

/**
 * Two replicas can accept one suggestion before they meet. Each applies the edit, so after the
 * merge the text holds it twice. Every replica runs this after a merge and reaches the same
 * result: the application with the lowest client id stays, the others are undone, and the
 * decision and the edit log name that one.
 */
export function settle(ydoc: Y.Doc): void {
  const applied = ydoc.getMap<Application>(APPLIED);
  const groups = new Map<string, [string, Application][]>();
  for (const [key, record] of applied) {
    const id = key.slice(0, key.lastIndexOf(":"));
    groups.set(id, [...(groups.get(id) ?? []), [key, record]]);
  }
  if (groups.size === 0) return;
  const suggestions = ydoc.getMap<Y.Map<unknown>>("suggestions");
  const log = ydoc.getArray<{ author: unknown; at: string; suggestion?: { id: string } }>("edits");
  ydoc.transact(() => {
    for (const [id, records] of groups) {
      records.sort((a, b) => clientOf(a[0]) - clientOf(b[0]));
      const [[, winner], ...losers] = records;
      const fields = suggestions.get(id);
      const decided = (key: string) => JSON.stringify(fields?.get(key));
      if (fields && (decided("status") !== '"accepted"' || decided("decidedBy") !== JSON.stringify(winner.by) || decided("decidedAt") !== JSON.stringify(winner.at))) {
        fields.set("status", "accepted");
        fields.set("decidedBy", winner.by);
        fields.set("decidedAt", winner.at);
      }
      if (losers.length === 0) continue;
      for (const [key, loser] of losers) {
        applied.delete(key);
        if (!loser.start || !loser.end) continue;
        const from = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(loser.start), ydoc);
        const to = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(loser.end), ydoc);
        if (from && to && from.type === to.type && to.index > from.index && from.type instanceof Y.XmlText) {
          from.type.delete(from.index, to.index - from.index);
        }
      }
      const entries = log.toArray().flatMap((e, i) => (e.suggestion?.id === id ? [{ e, i }] : []));
      const keep = entries.find(({ e }) => e.at === winner.at && JSON.stringify(e.author) === JSON.stringify(winner.by)) ?? entries[0];
      for (const { i } of entries.reverse()) if (i !== keep?.i) log.delete(i, 1);
    }
  });
}
