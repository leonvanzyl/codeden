import { Role } from "@codeden/contracts";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppShell } from "@/components/shell/app-shell";
import { AppToaster } from "@/components/shell/app-toaster";
import { SignInScreen } from "@/components/shell/sign-in";
import { UnauthorizedScreen } from "@/components/shell/unauthorized";
import { AGENT_TABS, AgentsPage, type AgentTab } from "@/routes/agents";
import { AutomationPage } from "@/routes/automation";
import { NewAutomationPage } from "@/routes/automation-new";
import { AutomationsPage, type AutomationsTab } from "@/routes/automations";
import { FactoryItemPage } from "@/routes/factory-item";
import { HomePage } from "@/routes/home";
import { InboxPage } from "@/routes/inbox";
import { NewSessionPage } from "@/routes/new-session";
import { PmPage } from "@/routes/pm";
import { ProjectPage, type ProjectTab } from "@/routes/project";
import { ReportsPage } from "@/routes/reports";
import { SearchPage } from "@/routes/search";
import { SessionPage } from "@/routes/session";
import { SettingsPage } from "@/routes/settings";
import { SetupPage } from "@/routes/setup";
import { VisionPage } from "@/routes/vision";
import { useConnectionStore } from "@/stores/connection";

function Root() {
  const auth = useConnectionStore((s) => s.auth);
  if (auth === "unauthorized") return <UnauthorizedScreen />;
  if (auth === "signin") return <SignInScreen />;
  return (
    <>
      <Outlet />
      <AppToaster />
    </>
  );
}

const rootRoute = createRootRoute({ component: Root });

const shell = createRoute({ getParentRoute: () => rootRoute, id: "shell", component: AppShell });

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const sessionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/sessions/$sessionId",
  // A transcript search hit: `?item=` opens the transcript at this item; `thread` and
  // `threadItem` also open a subagent's thread beside it at that item.
  validateSearch: (
    s: Record<string, unknown>,
  ): { item?: string; thread?: string; threadItem?: string } => {
    const [item, thread, threadItem] = [text(s.item), text(s.thread), text(s.threadItem)];
    return {
      ...(item ? { item } : {}),
      ...(thread && threadItem ? { thread, threadItem } : {}),
    };
  },
  component: function Session() {
    const { sessionId } = sessionRoute.useParams();
    const { item, thread, threadItem } = sessionRoute.useSearch();
    return (
      <SessionPage
        sessionId={sessionId}
        focusItemId={item}
        focusThread={thread && threadItem ? { threadId: thread, itemId: threadItem } : undefined}
      />
    );
  },
});

const searchRoute = createRoute({
  getParentRoute: () => shell,
  path: "/search",
  // `archived=false` leaves out archived sessions (they are included by default).
  validateSearch: (
    s: Record<string, unknown>,
  ): { q?: string; project?: string; role?: Role; archived?: false } => {
    const role = Role.safeParse(s.role);
    return {
      ...(text(s.q) ? { q: text(s.q) } : {}),
      ...(text(s.project) ? { project: text(s.project) } : {}),
      ...(role.success ? { role: role.data } : {}),
      ...(s.archived === false || s.archived === "false" ? { archived: false as const } : {}),
    };
  },
  component: function Search() {
    const { q, project, role, archived } = searchRoute.useSearch();
    return (
      <SearchPage
        q={q ?? ""}
        filters={{ projectId: project, role, includeArchived: archived !== false }}
      />
    );
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
  // `?newSession=true` opened the old New session dialog; links to it open the draft now.
  beforeLoad: ({ search, params }) => {
    if (search.newSession) {
      throw redirect({ to: "/projects/$projectId/new", params, replace: true });
    }
  },
  component: function Project() {
    const { projectId } = projectRoute.useParams();
    const { tab, archived } = projectRoute.useSearch();
    return (
      <ProjectPage
        key={projectId}
        projectId={projectId}
        tab={tab ?? "overview"}
        sessionView={archived ? "archived" : "active"}
      />
    );
  },
});

const newSessionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/new",
  component: function NewSession() {
    const { projectId } = newSessionRoute.useParams();
    return <NewSessionPage key={projectId} projectId={projectId} />;
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

const inboxRoute = createRoute({
  getParentRoute: () => shell,
  path: "/inbox",
  // `?item=` scrolls that item into view (a toast's Open).
  validateSearch: (s: Record<string, unknown>): { item?: string } =>
    typeof s.item === "string" && s.item ? { item: s.item } : {},
  component: function Inbox() {
    const { item } = inboxRoute.useSearch();
    return <InboxPage focusItemId={item} />;
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
    inboxRoute,
    reportsRoute,
    searchRoute,
    sessionRoute,
    projectRoute,
    newSessionRoute,
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
