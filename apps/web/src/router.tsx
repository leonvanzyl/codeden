import { Role } from "@codeden/contracts";
import {
  type AsyncRouteComponent,
  createRootRoute,
  createRoute,
  createRouter,
  ErrorComponent,
  type ErrorComponentProps,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PanelLoading, ReloadPrompt } from "@/components/common/lazy-component";
import { FactoryGuideSheet } from "@/components/factory/factory-guide";
import { AppShell } from "@/components/shell/app-shell";
import { AppToaster } from "@/components/shell/app-toaster";
import { SignInScreen } from "@/components/shell/sign-in";
import { UnauthorizedScreen } from "@/components/shell/unauthorized";
import { isChunkLoadError } from "@/lib/chunk-error";
import { AGENT_TABS, type AgentTab } from "@/routes/agent-tabs";
import type { AutomationsTab } from "@/routes/automations";
import type { ProjectTab } from "@/routes/project";
import { useConnectionStore } from "@/stores/connection";

/*
 * Every page loads from its own chunk, so the first load downloads only the shell and the page
 * it opens; heavy libraries go further, behind `@/components/on-demand` (see apps/web/README.md).
 * A chunk that fails to load after an update reloads the app once, then shows a reload prompt.
 */
const AgentsPage = lazyRouteComponent(() => import("@/routes/agents"), "AgentsPage");
const AutomationPage = lazyRouteComponent(() => import("@/routes/automation"), "AutomationPage");
const NewAutomationPage = lazyRouteComponent(
  () => import("@/routes/automation-new"),
  "NewAutomationPage",
);
const AutomationsPage = lazyRouteComponent(() => import("@/routes/automations"), "AutomationsPage");
const FactoryItemPage = lazyRouteComponent(
  () => import("@/routes/factory-item"),
  "FactoryItemPage",
);
const FactoryViewPage = lazyRouteComponent(
  () => import("@/routes/factory-view"),
  "FactoryViewPage",
);
const HomePage = lazyRouteComponent(() => import("@/routes/home"), "HomePage");
const InboxPage = lazyRouteComponent(() => import("@/routes/inbox"), "InboxPage");
const NewSessionPage = lazyRouteComponent(() => import("@/routes/new-session"), "NewSessionPage");
const PmPage = lazyRouteComponent(() => import("@/routes/pm"), "PmPage");
const ProjectPage = lazyRouteComponent(() => import("@/routes/project"), "ProjectPage");
const ReportsPage = lazyRouteComponent(() => import("@/routes/reports"), "ReportsPage");
const SearchPage = lazyRouteComponent(() => import("@/routes/search"), "SearchPage");
const SessionPage = lazyRouteComponent(() => import("@/routes/session"), "SessionPage");
const SettingsPage = lazyRouteComponent(() => import("@/routes/settings"), "SettingsPage");
const SetupPage = lazyRouteComponent(() => import("@/routes/setup"), "SetupPage");
const VisionPage = lazyRouteComponent(() => import("@/routes/vision"), "VisionPage");

/**
 * A route component that renders the lazy `page` with the route's params. Passing on the page's
 * `preload` lets the router fetch its chunk before it shows the route (the current page stays up
 * meanwhile) and when a link to it is hovered or focused (`defaultPreload: "intent"`).
 */
function withPage(
  page: Pick<AsyncRouteComponent<never>, "preload">,
  component: () => ReactNode,
): AsyncRouteComponent<object> {
  return Object.assign(component, { preload: async () => page.preload?.() });
}

/** A page that failed to render; a chunk that couldn't be fetched offers a reload. */
function RouteError({ error }: ErrorComponentProps) {
  return isChunkLoadError(error) ? <ReloadPrompt /> : <ErrorComponent error={error} />;
}

function Root() {
  const auth = useConnectionStore((s) => s.auth);
  if (auth === "unauthorized") return <UnauthorizedScreen />;
  if (auth === "signin") return <SignInScreen />;
  return (
    <>
      <Outlet />
      <AppToaster />
      <FactoryGuideSheet />
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
  component: withPage(SessionPage, function Session() {
    const { sessionId } = sessionRoute.useParams();
    const { item, thread, threadItem } = sessionRoute.useSearch();
    return (
      <SessionPage
        sessionId={sessionId}
        focusItemId={item}
        focusThread={thread && threadItem ? { threadId: thread, itemId: threadItem } : undefined}
      />
    );
  }),
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
  component: withPage(SearchPage, function Search() {
    const { q, project, role, archived } = searchRoute.useSearch();
    return (
      <SearchPage
        q={q ?? ""}
        filters={{ projectId: project, role, includeArchived: archived !== false }}
      />
    );
  }),
});

const projectRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId",
  validateSearch: (
    s: Record<string, unknown>,
  ): { newSession?: boolean; tab?: ProjectTab; archived?: boolean } => ({
    ...(s.newSession ? { newSession: true } : {}),
    ...(s.tab === "github" || s.tab === "tech-debt" || s.tab === "settings" ? { tab: s.tab } : {}),
    // The sessions list shows archived sessions (from the sidebar's "N archived" row).
    ...(s.archived ? { archived: true } : {}),
  }),
  // `?newSession=true` opened the old New session dialog; links to it open the draft now.
  beforeLoad: ({ search, params }) => {
    if (search.newSession) {
      throw redirect({ to: "/projects/$projectId/new", params, replace: true });
    }
  },
  component: withPage(ProjectPage, function Project() {
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
  }),
});

const newSessionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/new",
  component: withPage(NewSessionPage, function NewSession() {
    const { projectId } = newSessionRoute.useParams();
    return <NewSessionPage key={projectId} projectId={projectId} />;
  }),
});

const pmRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/pm",
  component: withPage(PmPage, function Pm() {
    const { projectId } = pmRoute.useParams();
    return <PmPage key={projectId} projectId={projectId} />;
  }),
});

const AUTOMATION_TABS: AutomationsTab[] = ["automations", "runs", "templates"];
const automationsRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/automations",
  validateSearch: (s: Record<string, unknown>): { tab?: AutomationsTab } =>
    AUTOMATION_TABS.includes(s.tab as AutomationsTab) && s.tab !== "automations"
      ? { tab: s.tab as AutomationsTab }
      : {},
  component: withPage(AutomationsPage, function Automations() {
    const { projectId } = automationsRoute.useParams();
    const { tab } = automationsRoute.useSearch();
    return <AutomationsPage key={projectId} projectId={projectId} tab={tab ?? "automations"} />;
  }),
});

const newAutomationRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/automations/new",
  // Prefilled from a template (`?template=`) or from a session (`?session=`, "Make an automation…").
  validateSearch: (s: Record<string, unknown>): { template?: string; session?: string } => ({
    ...(typeof s.template === "string" && s.template ? { template: s.template } : {}),
    ...(typeof s.session === "string" && s.session ? { session: s.session } : {}),
  }),
  component: withPage(NewAutomationPage, function NewAutomation() {
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
  }),
});

const automationRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/automations/$automationId",
  component: withPage(AutomationPage, function AutomationDetail() {
    const { projectId, automationId } = automationRoute.useParams();
    return <AutomationPage key={automationId} projectId={projectId} automationId={automationId} />;
  }),
});

const factoryItemRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/factory/$itemId",
  component: withPage(FactoryItemPage, function FactoryItemDetail() {
    const { projectId, itemId } = factoryItemRoute.useParams();
    return <FactoryItemPage key={itemId} projectId={projectId} itemId={itemId} />;
  }),
});

/**
 * The Factory view: full screen, outside the app shell (no sidebar or side panels), so it can be
 * kept open on a second screen. Its static `view` segment ranks above `factory/$itemId`.
 */
const factoryViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/factory/view",
  component: withPage(FactoryViewPage, function FactoryView() {
    const { projectId } = factoryViewRoute.useParams();
    return <FactoryViewPage key={projectId} projectId={projectId} />;
  }),
});

const visionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/projects/$projectId/vision",
  component: withPage(VisionPage, function Vision() {
    const { projectId } = visionRoute.useParams();
    return <VisionPage projectId={projectId} />;
  }),
});

const settingsSectionRoute = createRoute({
  getParentRoute: () => shell,
  path: "/settings/$section",
  component: withPage(SettingsPage, function Settings() {
    const { section } = settingsSectionRoute.useParams();
    return <SettingsPage section={section} />;
  }),
});

const agentsRoute = createRoute({
  getParentRoute: () => shell,
  path: "/agents",
  validateSearch: (s: Record<string, unknown>): { tab?: AgentTab; project?: string } => ({
    tab: AGENT_TABS.some((t) => t.id === s.tab) ? (s.tab as AgentTab) : undefined,
    project: typeof s.project === "string" ? s.project : undefined,
  }),
  component: withPage(AgentsPage, function Agents() {
    const { tab, project } = agentsRoute.useSearch();
    return <AgentsPage tab={tab ?? "memory"} projectId={project ?? null} />;
  }),
});

const inboxRoute = createRoute({
  getParentRoute: () => shell,
  path: "/inbox",
  // `?item=` scrolls that item into view (a toast's Open).
  validateSearch: (s: Record<string, unknown>): { item?: string } =>
    typeof s.item === "string" && s.item ? { item: s.item } : {},
  component: withPage(InboxPage, function Inbox() {
    const { item } = inboxRoute.useSearch();
    return <InboxPage focusItemId={item} />;
  }),
});

const reportsRoute = createRoute({
  getParentRoute: () => shell,
  path: "/reports",
  validateSearch: (s: Record<string, unknown>): { project?: string } =>
    typeof s.project === "string" ? { project: s.project } : {},
  component: withPage(ReportsPage, function Reports() {
    const { project } = reportsRoute.useSearch();
    return <ReportsPage key={project ?? "all"} projectId={project} />;
  }),
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
  factoryViewRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // A page whose chunk takes longer than a second (a slow link) shows a spinner meanwhile.
  defaultPendingComponent: PanelLoading,
  defaultErrorComponent: RouteError,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
