// Its own module, so the browser editor can check a kind without loading the document engine.
import type { PrincipalKind } from "agentic-identity";

export type { PrincipalKind };

/** Every kind but `human` is a machine, so its work is labeled as machine-made. */
export const isMachine = (kind: string): boolean => kind !== "human";
