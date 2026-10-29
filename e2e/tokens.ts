// Tokens are 32 bytes or more. The Worker refuses a shorter one.
export const ADA = `ada-${"a".repeat(40)}`;
export const BOB = `bob-${"b".repeat(40)}`;
export const BOT = `bot-${"c".repeat(40)}`;
export const VIC = `vic-${"v".repeat(40)}`;

export const TOKENS = {
  [ADA]: "human:Ada",
  [BOB]: "human:Bob",
  [BOT]: "agent_of_human:Scribe",
  [VIC]: { as: "human:Vic", role: "viewer" },
};
