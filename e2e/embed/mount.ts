// A host page for the whole app. It uses the package exports as a host would: `mount` of `agentic-documents/ui`.
import { mount } from "agentic-documents/ui";
import "agentic-design/styles.css";
import "agentic-documents/ui.css";
import "agentic-documents/app.css";

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("token") ?? "";
const app = mount(document.getElementById("app")!, { baseUrl: location.origin, getToken: () => token, documentId: params.get("id") ?? undefined });
Object.assign(window, { unmountApp: () => app.unmount() });
