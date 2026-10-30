// Failure cases: invalid author, person posing as assistant, ambiguous/stale target,
// proposal mutating text, and an agent deciding its own proposal even with scope.
import { expect, test } from "vitest";
import { AgenticDoc, Suggestions, createAssistantSuggestions } from "./index.js";
const human = { kind: "human" as const, name: "Ada" };
test("assistant proposals keep text intact and enforce authorship and anchors", () => {
  const doc = AgenticDoc.fromMarkdown("Hello world world", human);
  expect(() => createAssistantSuggestions(doc, human)).toThrow();
  expect(() => createAssistantSuggestions(doc, { name: "bot" } as never)).toThrow();
  const bot = { kind: "agent" as const, name: "bot", scopes: ["docs:accept"] };
  const port = createAssistantSuggestions(doc, bot);
  bot.name = "changed";
  expect(() => port.propose({ target: { text: "world" }, replacement: "earth" })).toThrow(/matches/);
  const anchor = doc.anchor("Hello");
  const id = port.propose({ target: { anchor }, replacement: "Hi" });
  expect(doc.toMarkdown()).toContain("Hello world world");
  const suggestions = new Suggestions(doc);
  expect(suggestions.list()[0].author.name).toBe("bot");
  for (const action of ["accept", "reject"] as const) {
    expect(() => suggestions[action](id, { ...bot, name: "bot" })).toThrow(/cannot/);
  }
  doc.delete({ text: "Hello" }, human);
  expect(() => port.propose({ target: { anchor }, replacement: "Hi" })).toThrow();
  expect(suggestions.list()).toHaveLength(1);
});
