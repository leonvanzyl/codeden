import "@/lib/zod-jitless";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "@/components/common/app-error-boundary";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiRequestError, ClientProvider, createClient } from "@/lib/api";
import { installClipboardFallback } from "@/lib/clipboard";
import { notifyCopyFailed } from "@/lib/copy";
import { platform } from "@/lib/platform";
import { startRealtime } from "@/lib/realtime";
import { startThemeSync } from "@/lib/theme/sync";
import { router } from "@/router";
import { applyTheme, useThemeStore } from "@/stores/theme";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      // Client errors (missing route, bad request, no checkpoints yet) won't fix themselves.
      retry: (count, error) =>
        !(error instanceof ApiRequestError && error.status >= 400 && error.status < 500) &&
        count < 2,
    },
  },
});
const client = createClient();

applyTheme(useThemeStore.getState());
useThemeStore.subscribe(applyTheme);
// `system` follows the OS while the app is open.
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", (e) => useThemeStore.setState({ systemDark: !e.matches }));
startRealtime(client, queryClient);
startThemeSync(client, queryClient);
// Phones on the LAN use plain http, where browsers hide the Clipboard API; code block copy
// buttons in rendered markdown call it directly.
installClipboardFallback(notifyCopyFailed);
// `codeden://` links opened while the desktop app runs (§17).
platform.onNavigate((path) => router.history.push(path));

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <ClientProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={300}>
            <RouterProvider router={router} />
          </TooltipProvider>
        </QueryClientProvider>
      </ClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
