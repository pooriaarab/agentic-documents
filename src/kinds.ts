// Its own module, so the browser editor can check a kind without loading the document engine.
export const PRINCIPAL_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Every kind but `human` is a machine, so its work is labeled as machine-made. */
export const isMachine = (kind: string): boolean => kind !== "human";
