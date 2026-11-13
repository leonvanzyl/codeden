import { createContext, type ReactNode, useContext } from "react";
import { useConnectionStore } from "@/stores/connection";
import type { CodeDenClient } from "./client";
import { createHttpClient } from "./http-client";
import { createMockClient } from "./mock";

export type { CodeDenClient, InboxResolution, SendMode } from "./client";
export { ApiRequestError } from "./http";

/**
 * Mock mode only when `VITE_CODEDEN_MOCK=1` is set explicitly (UI work without a server).
 * Everything else, and every production build, talks to the real server.
 */
export const isMockMode: boolean = import.meta.env.VITE_CODEDEN_MOCK === "1" && import.meta.env.DEV;

/** Base URL of the CodeDen server (same origin by default; configurable for a desktop shell). */
export const serverOrigin: string = import.meta.env.VITE_CODEDEN_SERVER ?? window.location.origin;

export function createClient(): CodeDenClient {
  if (isMockMode) return createMockClient({ ambient: true });
  return createHttpClient(serverOrigin, {
    onUnauthorized: (code) =>
      useConnectionStore
        .getState()
        .setAuth(code === "sign_in_required" ? "signin" : "unauthorized"),
  });
}

const ClientContext = createContext<CodeDenClient | null>(null);

export function ClientProvider({
  client,
  children,
}: {
  client: CodeDenClient;
  children: ReactNode;
}) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

/** The active API client. */
export function useClient(): CodeDenClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useClient must be used inside <ClientProvider>");
  return client;
}
