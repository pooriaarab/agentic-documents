import { createContext, useContext } from "react";
import { createClient, DocsApiError, type DocsClient, type Me } from "../src/client.js";

const KEY = "agentic-documents.token";

// The token stays in this tab only. Closing the tab signs you out.
export const savedToken = (): string | null => sessionStorage.getItem(KEY);
export const saveToken = (token: string): void => sessionStorage.setItem(KEY, token);
export const forgetToken = (): void => sessionStorage.removeItem(KEY);

export const clientFor = (token: string): DocsClient => createClient({ baseUrl: location.origin, token });

export interface Session {
  api: DocsClient;
  token: string;
  me: Me;
  signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("no session");
  return session;
}

/** A sentence for the person. The API error code is kept for the logic that needs it. */
export function describe(error: unknown): string {
  if (error instanceof DocsApiError) {
    if (error.code === "UNAUTHENTICATED") return "The server did not accept this token.";
    if (error.code === "FORBIDDEN") return "This token may not do that.";
    if (error.code === "NO_DOCUMENT") return "This document does not exist. It may have been removed.";
    return error.message;
  }
  return error instanceof Error ? `Could not reach the server: ${error.message}` : "Something went wrong.";
}

export { isMachine } from "../src/kinds.js";
