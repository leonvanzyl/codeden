import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";
import { SignInScreen } from "@/components/shell/sign-in";
import { UnauthorizedScreen } from "@/components/shell/unauthorized";
import { Toaster } from "@/components/ui/sonner";
import { AGENT_TABS, AgentsPage, type AgentTab } from "@/routes/agents";
import { AutomationPage } from "@/routes/automation";
import { NewAutomationPage } from "@/routes/automation-new";
import { AutomationsPage, type AutomationsTab } from "@/routes/automations";
import { FactoryItemPage } from "@/routes/factory-item";
import { HomePage } from "@/routes/home";
import { InboxPage } from "@/routes/inbox";
import { PmPage } from "@/routes/pm";
import { ProjectPage, type ProjectTab } from "@/routes/project";
import { ReportsPage } from "@/routes/reports";
import { SessionPage } from "@/routes/session";
import { SettingsPage } from "@/routes/settings";
import { SetupPage } from "@/routes/setup";
import { VisionPage } from "@/routes/vision";
import { useConnectionStore } from "@/stores/connection";
import { useUiStore } from "@/stores/ui";

function Root() {
  const auth = useConnectionStore((s) => s.auth);
  // A native browser view paints over the page, toasts included: keep them on the other side.
  const nativeShown = useUiStore((s) => s.nativeBrowserShown);
  if (auth === "unauthorized") return <UnauthorizedScreen />;
  if (auth === "signin") return <SignInScreen />;
  return (
    <>
      <Outlet />
      <Toaster position={nativeShown ? "bottom-left" : "bottom-right"} />
    </>
  );
}

const rootRoute = createRootRoute({ component: Root });

const shell = createRoute({ getParentRoute: () => rootRoute, id: "shell", component: AppShell });

const sessionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/sessions/$sessionId",
  component: function Session() {
    const { sessionId } = sessionRoute.useParams();
    return <SessionPage sessionId={sessionId} />;
  },
});

const projectRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId",
  validateSearch: (
    s: Record<string, unknown>,
  ): { newSession?: boolean; tab?: ProjectTab; archived?: boolean } => ({
    ...(s.newSession ? { newSession: true } : {}),
    ...(s.tab === "github" ? { tab: "github" as const } : {}),
    // The sessions list shows archived sessions (from the sidebar's "N archived" row).
    ...(s.archived ? { archived: true } : {}),
  }),
  component: function Project() {
    const { projectId } = projectRoute.useParams();
    const { newSession, tab, archived } = projectRoute.useSearch();
    return (
      <ProjectPage
        key={projectId}
        projectId={projectId}
        newSession={Boolean(newSession)}
        tab={tab ?? "overview"}
        sessionView={archived ? "archived" : "active"}
      />
    );
  },
});

const pmRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/pm",
  component: function Pm() {
    const { projectId } = pmRoute.useParams();
    return <PmPage key={projectId} projectId={projectId} />;
  },
});

const AUTOMATION_TABS: AutomationsTab[] = ["automations", "runs", "templates"];
const automationsRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/automations",
  validateSearch: (s: Record<string, unknown>): { tab?: AutomationsTab } =>
    AUTOMATION_TABS.includes(s.tab as AutomationsTab) && s.tab !== "automations"
      ? { tab: s.tab as AutomationsTab }
      : {},
  component: function Automations() {
    const { projectId } = automationsRoute.useParams();
    const { tab } = automationsRoute.useSearch();
    return <AutomationsPage key={projectId} projectId={projectId} tab={tab ?? "automations"} />;
  },
});

const newAutomationRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/automations/new",
  // Prefilled from a template (`?template=`) or from a session (`?session=`, "Make an automation…").
  validateSearch: (s: Record<string, unknown>): { template?: string; session?: string } => ({
    ...(typeof s.template === "string" && s.template ? { template: s.template } : {}),
    ...(typeof s.session === "string" && s.session ? { session: s.session } : {}),
  }),
  component: function NewAutomation() {
    const { projectId } = newAutomationRoute.useParams();
    const { template, session } = newAutomationRoute.useSearch();
    return (
      <NewAutomationPage
        key={`${projectId}:${template ?? ""}:${session ?? ""}`}
        projectId={projectId}
        templateId={session ? undefined : template}
        sessionId={session}
      />
    );
  },
});

const automationRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/automations/$automationId",
  component: function AutomationDetail() {
    const { projectId, automationId } = automationRoute.useParams();
    return <AutomationPage key={automationId} projectId={projectId} automationId={automationId} />;
  },
});

const factoryItemRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/factory/$itemId",
  component: function FactoryItemDetail() {
    const { projectId, itemId } = factoryItemRoute.useParams();
    return <FactoryItemPage key={itemId} projectId={projectId} itemId={itemId} />;
  },
});

const visionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/vision",
  component: function Vision() {
    const { projectId } = visionRoute.useParams();
    return <VisionPage projectId={projectId} />;
  },
});

const settingsSectionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/settings/$section",
  component: function Settings() {
    const { section } = settingsSectionRoute.useParams();
    return <SettingsPage section={section} />;
  },
});

const agentsRoute = createRoute({
  getParentRoute: () => shell,
  path: "/agents",
  validateSearch: (s: Record<string, unknown>): { tab?: AgentTab; project?: string } => ({
    tab: AGENT_TABS.some((t) => t.id === s.tab) ? (s.tab as AgentTab) : undefined,
    project: typeof s.project === "string" ? s.project : undefined,
  }),
  component: function Agents() {
    const { tab, project } = agentsRoute.useSearch();
    return <AgentsPage tab={tab ?? "memory"} projectId={project ?? null} />;
  },
});

const reportsRoute = createRoute({
  getParentRoute: () => shell,
  path: "/reports",
  validateSearch: (s: Record<string, unknown>): { project?: string } =>
    typeof s.project === "string" ? { project: s.project } : {},
  component: function Reports() {
    const { project } = reportsRoute.useSearch();
    return <ReportsPage key={project ?? "all"} projectId={project} />;
  },
});

const routeTree = rootRoute.addChildren([
  shell.addChildren([
    createRoute({ getParentRoute: () => shell, path: "/", component: HomePage }),
    createRoute({ getParentRoute: () => shell, path: "/inbox", component: InboxPage }),
    reportsRoute,
    sessionRoute,
    projectRoute,
    pmRoute,
    automationsRoute,
    newAutomationRoute,
    automationRoute,
    factoryItemRoute,
    visionRoute,
    createRoute({
      getParentRoute: () => shell,
      path: "/settings",
      beforeLoad: () => {
        throw redirect({ to: "/settings/$section", params: { section: "general" } });
      },
    }),
    settingsSectionRoute,
    agentsRoute,
  ]),
  createRoute({ getParentRoute: () => rootRoute, path: "/setup", component: SetupPage }),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
