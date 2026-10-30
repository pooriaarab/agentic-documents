import { createRoot } from "react-dom/client";
import { AgenticDoc, createAssistantSuggestions, ReviewPanel } from "agentic-documents/ui";
const human = { kind: "human" as const, name: "Ada" };
const bot = { kind: "agent" as const, name: "Scribe", scopes: ["docs:accept"] };
const doc = AgenticDoc.fromMarkdown("Hello world", human);
createAssistantSuggestions(doc, bot).propose({ target: { text: "world" }, replacement: "earth" });
const principal = location.hash === "#self" ? bot : human;
createRoot(document.getElementById("editor")!).render(<main>
  <h1>Review example</h1>
  <ReviewPanel doc={doc} principal={principal} writable onAnchor={(anchor) => {
    doc.resolve({ anchor });
    document.getElementById("anchor")!.textContent = anchor.text;
  }} />
  <p id="anchor" role="status" />
</main>);
