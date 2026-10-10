import {
  Inbox,
  InboxState,
  inboxSummaryOf,
  loadInbox,
  type InboxHeader,
} from "./inbox.js";
import { QuestionResponseStates } from "./question-response-state.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import {
  Folder,
  Gauge,
  InboxIcon,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Plus,
  Search as SearchIcon,
  Settings,
} from "lucide-react";
import {
  workspaceSchema,
  type Session,
  type Workspace,
} from "../../src/operator/contracts.js";
import { ClientError, OperatorClient } from "./api.js";
import { useOperatorResource } from "./resource.js";
import {
  ActionLink,
  Button,
  StatusBadge,
  ResourceStatus,
  MobileNavigation,
  NavigationRow,
  PageHeader,
} from "./components.js";
import { Alert } from "./ui/alert.js";
import { loadTaskList } from "./tasks.js";
import { TaskComposer } from "./task-composer.js";
import { RuntimeSettings, AssignmentRecovery } from "./recovery.js";
import { ConfigurationDrafts } from "./settings-state.js";
import {
  SettingsWorkspace,
  ProjectSetup,
  ProjectConfiguration,
  ProfileConfiguration,
} from "./settings.js";
import { Search, SearchState } from "./search.js";
import { TaskWorkspace } from "./task-workspace.js";
import { TaskWorkspaceStates } from "./task-workspace-state.js";
import { TaskViews } from "./task-views.js";
import { Login, SignInBootstrap } from "./sign-in.js";
import { NotFound, notFoundSubtitle } from "./not-found.js";
import { AccountMenu, OPERATOR_LABEL } from "./account-menu.js";
function RouteLink({
  href,
  current,
  navigate,
  icon,
  row,
  trailing,
  className,
  describedBy,
  children,
}: {
  href: string;
  current: boolean;
  navigate: (path: string) => void;
  icon: ReactNode;
  row: boolean;
  trailing?: ReactNode;
  className?: string;
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <a
      className={`nav-link${row ? " nav-row" : ""}${className ? ` ${className}` : ""}`}
      href={href}
      aria-current={current ? "page" : undefined}
      aria-describedby={describedBy}
      onClick={(e) => {
        if (
          e.button === 0 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.altKey
        ) {
          e.preventDefault();
          navigate(href);
        }
      }}
    >
      {row ? (
        <NavigationRow icon={icon} title={children} trailing={trailing} />
      ) : (
        <>
          {icon}
          <span className="nav-label">
            <span>{children}</span>
          </span>
          {trailing}
        </>
      )}
    </a>
  );
}
const navIcon = { "aria-hidden": true, className: "nav-icon" } as const;
function ProjectNavigation({
  workspace,
  path,
  navigate,
  inboxCount,
  row,
}: {
  workspace: Workspace | null;
  path: string;
  navigate: (path: string) => void;
  inboxCount: number | null;
  row: boolean;
}) {
  const countId = useId();
  const pathname = path.split(/[?#]/)[0] ?? "";
  const link = (
    href: string,
    current: boolean,
    icon: ReactNode,
    label: ReactNode,
    extra: {
      trailing?: ReactNode;
      className?: string;
      describedBy?: string;
    } = {},
  ) => (
    <RouteLink
      href={href}
      current={current}
      navigate={navigate}
      icon={icon}
      row={row}
      {...extra}
    >
      {label}
    </RouteLink>
  );
  return (
    <nav aria-label="Operator navigation">
      {link(
        "/app",
        pathname === "/app",
        <LayoutDashboard {...navIcon} />,
        "Overview",
      )}
      {link(
        "/app/inbox",
        pathname === "/app/inbox",
        <InboxIcon {...navIcon} />,
        "Inbox",
        inboxCount === null
          ? {}
          : {
              describedBy: countId,
              trailing: (
                <>
                  <span className="nav-count metadata" aria-hidden="true">
                    {inboxCount}
                  </span>
                  <span id={countId} hidden>
                    {inboxCount} unresolved
                  </span>
                </>
              ),
            },
      )}
      {link(
        "/app/tasks",
        pathname === "/app/tasks",
        <ListChecks {...navIcon} />,
        "Tasks",
      )}
      {link(
        "/app/search",
        pathname === "/app/search",
        <SearchIcon {...navIcon} />,
        "Search",
      )}
      <h2 className="nav-heading">Projects</h2>
      {workspace?.data.projects.length === 0 && (
        <p className="body muted">No projects yet.</p>
      )}
      {workspace?.data.projects.map((p) =>
        link(
          `/app/projects/${p.id}`,
          pathname === `/app/projects/${p.id}`,
          <Folder {...navIcon} />,
          p.name ?? "Name unavailable",
          {
            trailing: p.paused ? (
              <StatusBadge tone="warning">Paused</StatusBadge>
            ) : undefined,
          },
        ),
      )}
      {link(
        "/app/settings/projects/new",
        pathname === "/app/settings/projects/new",
        <Plus {...navIcon} />,
        "New project",
      )}
    </nav>
  );
}
/** Phone drawer account group: always visible rows, since no popup is nested in the Sheet. */
function AccountRows({
  path,
  navigate,
  pending,
  onSignOut,
}: {
  path: string;
  navigate: (path: string) => void;
  pending: boolean;
  onSignOut: () => void;
}) {
  const pathname = path.split(/[?#]/)[0];
  return (
    <section className="account-rows" aria-label="Account">
      <p className="metadata muted">Signed in as {OPERATOR_LABEL}</p>
      <RouteLink
        href="/app/settings"
        current={pathname === "/app/settings"}
        navigate={navigate}
        icon={<Settings {...navIcon} />}
        row
      >
        Settings
      </RouteLink>
      <RouteLink
        href="/app/settings/runtime"
        current={pathname === "/app/settings/runtime"}
        navigate={navigate}
        icon={<Gauge {...navIcon} />}
        row
      >
        Runtime
      </RouteLink>
      <Button variant="secondary" disabled={pending} onClick={onSignOut}>
        <LogOut aria-hidden="true" />
        {pending ? "Signing out…" : "Sign out"}
      </Button>
    </section>
  );
}
/** Static parent of a nested route, for the phone Back link. Top-level routes have none. */
function parentRoute(
  pathname: string,
  search: string,
  workspace: Workspace | null,
): { href: string; label: string } | null {
  if (pathname === "/app/tasks/new") {
    const id = new URLSearchParams(search).get("project");
    return id
      ? {
          href: `/app/projects/${encodeURIComponent(id)}`,
          label:
            workspace?.data.projects.find((p) => p.id === id)?.name ??
            "Project",
        }
      : { href: "/app/tasks", label: "Tasks" };
  }
  if (/^\/app\/tasks\/[^/]+$/.test(pathname))
    return { href: "/app/tasks", label: "Tasks" };
  if (/^\/app\/assignments\/[^/]+\/recovery$/.test(pathname))
    return { href: "/app/settings/runtime", label: "Runtime" };
  if (
    pathname.startsWith("/app/settings/") ||
    /^\/app\/(projects|profiles)\/[^/]+\/settings$/.test(pathname)
  )
    return { href: "/app/settings", label: "Settings" };
  return null;
}
/**
 * Whether an `/app` address matches a client route; mirrors the view chosen in `App` and the
 * service's `shell()` routes. Task ids are not checked here: the task workspace owns its own
 * not-found state for a malformed id.
 */
function knownRoute(pathname: string) {
  const id = "[a-f0-9-]{36}";
  return (
    [
      "/app",
      "/app/tasks",
      "/app/tasks/new",
      "/app/inbox",
      "/app/search",
      "/app/settings",
      "/app/settings/runtime",
      "/app/settings/projects/new",
      "/app/settings/profiles/new",
    ].includes(pathname) ||
    /^\/app\/tasks\/[^/]+$/.test(pathname) ||
    new RegExp(`^/app/projects/${id}$`).test(pathname) ||
    new RegExp(`^/app/assignments/${id}/recovery$`).test(pathname) ||
    new RegExp(`^/app/(?:projects|profiles)/${id}/settings$`).test(pathname)
  );
}
export function App() {
  const drafts = useRef(new ConfigurationDrafts());
  const acceptedIdentity = useRef<string | null>(null);
  const navigationScope = useRef(crypto.randomUUID());
  const clearPrivateNavigation = () => {
    const next =
      location.pathname === "/app/search"
        ? "/app/search"
        : location.pathname + location.search;
    history.replaceState(
      { navigationScope: navigationScope.current, navKey: crypto.randomUUID() },
      "",
      next,
    );
    setPath(next);
  };
  const clientRef = useRef<OperatorClient | null>(null);
  const [session, setSession] = useState<Session | null>(null),
    [bootstrapError, setBootstrapError] = useState(false),
    [bootstrap, setBootstrap] = useState(0),
    [path, setPath] = useState(location.pathname + location.search),
    [navigationVersion, setNavigationVersion] = useState(0),
    [drawer, setDrawer] = useState(false),
    [logoutPending, setLogoutPending] = useState(false),
    [logoutNotice, setLogoutNotice] = useState<string | null>(null),
    [expiredNotice, setExpiredNotice] = useState(false);
  const searchState = useRef(new Map<string, SearchState>());
  const taskStates = useRef(new TaskWorkspaceStates());
  const questionStates = useRef(new QuestionResponseStates());
  const inboxState = useRef(new InboxState());
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation purge uses current browser entry and stable scope ref.
  const expired = useCallback(() => {
    navigationScope.current = crypto.randomUUID();
    clearPrivateNavigation();
    clientRef.current?.invalidateAuthentication();
    acceptedIdentity.current = null;
    setLogoutPending(false);
    drafts.current.purge();
    taskStates.current.purge();
    questionStates.current.purge();
    inboxState.current.clear();
    searchState.current.clear();
    setSession(null);
    setExpiredNotice(true);
    setBootstrap((v) => v + 1);
    setDrawer(false);
  }, []);
  const client = useMemo(() => new OperatorClient(fetch, expired), [expired]);
  clientRef.current = client;
  // biome-ignore lint/correctness/useExhaustiveDependencies: browser-entry purge is needed only when accepting this exact current authentication scope.
  const acceptSession = useCallback(
    (next: Session) => {
      const identity = next.authenticated ? next.csrfToken : null;
      if (identity !== acceptedIdentity.current) {
        if (!identity && acceptedIdentity.current) {
          navigationScope.current = crypto.randomUUID();
          clearPrivateNavigation();
        }
        client.invalidateAuthentication();
        drafts.current.purge();
        taskStates.current.purge();
        questionStates.current.purge();
        inboxState.current.clear();
        searchState.current.clear();
        if (
          identity &&
          history.state?.navigationScope &&
          history.state.navigationScope !== navigationScope.current
        )
          clearPrivateNavigation();
        if (identity)
          history.replaceState(
            { ...history.state, navigationScope: navigationScope.current },
            "",
          );
        acceptedIdentity.current = identity;
        setLogoutPending(false);
      }
      if (next.authenticated) setExpiredNotice(false);
      setSession(next);
    },
    [client],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap explicitly refreshes the server session after expiry or retry.
  useEffect(() => {
    let active = true;
    setBootstrapError(false);
    const isCurrentScope = client.captureAuthenticationScope();
    client.session().then(
      (s) => {
        if (active && isCurrentScope()) acceptSession(s);
      },
      () => {
        if (active && isCurrentScope()) setBootstrapError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, bootstrap, acceptSession]);
  const restoreFocus = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: current scope ref guards browser Back/Forward entries across authentication expiry.
  useEffect(() => {
    const pop = () => {
      if (history.state?.navigationScope !== navigationScope.current) {
        clearPrivateNavigation();
        restoreFocus.current = null;
      } else restoreFocus.current = history.state?.focusedHref ?? null;
      setDrawer(false);
      setPath(location.pathname + location.search);
      setNavigationVersion((n) => n + 1);
      requestAnimationFrame(() =>
        scrollTo(
          0,
          (history.state as { scrollY?: number } | null)?.scrollY ?? 0,
        ),
      );
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const loader = useCallback(
    (signal: AbortSignal) =>
      client.read("/api/operator/workspace", workspaceSchema, signal),
    [client],
  );
  const workspace = useOperatorResource(
    session?.authenticated ? session.csrfToken : null,
    loader,
  );
  const taskLoader = useCallback(
    (signal: AbortSignal) => loadTaskList(client, signal),
    [client],
  );
  const tasks = useOperatorResource(
    session?.authenticated ? session.csrfToken : null,
    taskLoader,
  );
  const inboxLoader = useCallback(
    (signal: AbortSignal) => loadInbox(client, signal),
    [client],
  );
  // The Inbox route polls its own full read and reports its total, so the shell reads only elsewhere.
  const onInboxRoute = path.split(/[?#]/)[0] === "/app/inbox";
  const [inboxRouteSummary, setInboxRouteSummary] =
    useState<ReturnType<typeof inboxSummaryOf>>(null);
  const [inboxHeader, setInboxHeader] = useState<InboxHeader | null>(null);
  const inboxSummary = useOperatorResource(
    session?.authenticated ? session.csrfToken : null,
    inboxLoader,
    !onInboxRoute,
  );
  const taskRefresh = useRef(tasks.refresh);
  taskRefresh.current = tasks.refresh;
  const workspaceRefresh = useRef(workspace.refresh);
  workspaceRefresh.current = workspace.refresh;
  const inboxScope =
    session?.authenticated && path.split("?")[0] === "/app/inbox"
      ? session.csrfToken
      : null;
  useEffect(() => {
    if (!inboxScope) return;
    taskRefresh.current();
    const timer = setInterval(() => {
      taskRefresh.current();
      workspaceRefresh.current();
    }, 15000);
    return () => clearInterval(timer);
  }, [inboxScope]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the previous entry focus after its route and asynchronous task content render.
  useEffect(() => {
    const href = restoreFocus.current;
    if (!href) return;
    const target = [
      ...document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].find((a) => a.getAttribute("href") === href);
    if (target) {
      target.focus({ preventScroll: true });
      restoreFocus.current = null;
    }
  }, [path, navigationVersion, tasks.state.data, workspace.state.data]);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a"),
        href = anchor?.getAttribute("href");
      if (
        href?.startsWith("/app") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        e.button === 0
      ) {
        e.preventDefault();
        history.replaceState(
          { ...history.state, scrollY, focusedHref: href },
          "",
        );
        history.pushState(
          {
            origin: location.pathname + location.search,
            workspaceOrigin:
              location.pathname === "/app/search"
                ? history.state?.workspaceOrigin
                : location.pathname + location.search,
            navigationScope: navigationScope.current,
            navKey: crypto.randomUUID(),
            entryIndex: (history.state?.entryIndex ?? 0) + 1,
            workspaceIndex:
              location.pathname === "/app/search"
                ? (history.state?.workspaceIndex ?? 0)
                : (history.state?.entryIndex ?? 0),
          },
          "",
          href,
        );
        setPath(href);
        setNavigationVersion((n) => n + 1);
        setDrawer(false);
      }
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);
  const addressPath = path.split(/[?#]/)[0] ?? "/app";
  // A signed-in visit to /login lands on Overview, like the legacy server's redirect.
  const pathname =
    addressPath === "/login" && session?.authenticated ? "/app" : addressPath;
  useEffect(() => {
    if (pathname !== addressPath) {
      history.replaceState({ ...history.state }, "", "/app");
      setPath("/app");
    }
  }, [pathname, addressPath]);
  const navigate = (next: string) => {
    history.replaceState({ ...history.state, scrollY }, "");
    history.pushState(
      {
        origin: location.pathname + location.search,
        workspaceOrigin:
          location.pathname === "/app/search"
            ? history.state?.workspaceOrigin
            : location.pathname + location.search,
        navigationScope: navigationScope.current,
        navKey: crypto.randomUUID(),
        entryIndex: (history.state?.entryIndex ?? 0) + 1,
        workspaceIndex:
          location.pathname === "/app/search"
            ? (history.state?.workspaceIndex ?? 0)
            : (history.state?.entryIndex ?? 0),
      },
      "",
      next,
    );
    setPath(next);
    setNavigationVersion((n) => n + 1);
    setDrawer(false);
  };
  if (!session)
    return (
      <SignInBootstrap
        unavailable={bootstrapError}
        retry={() => setBootstrap((v) => v + 1)}
      />
    );
  if (!session.authenticated)
    return (
      <>
        <Login
          key={session.csrfToken}
          client={client}
          session={session}
          expired={expiredNotice}
          onSignedIn={(next) => {
            if (pathname === "/login") {
              history.replaceState(null, "", "/app");
              setPath("/app");
            }
            acceptSession(next);
          }}
        />
        {logoutNotice && (
          <p className="logout-notice body" role="alert">
            {logoutNotice} Current session requires sign-in.
          </p>
        )}
      </>
    );
  const entryKey = history.state?.navKey ?? path;
  let activeSearch = searchState.current.get(entryKey);
  if (!activeSearch) {
    activeSearch = new SearchState();
    searchState.current.set(entryKey, activeSearch);
  }
  const projectId = pathname.match(/^\/app\/projects\/([a-f0-9-]{36})$/)?.[1];
  const project = workspace.state.data?.data.projects.find(
    (p) => p.id === projectId,
  );
  const unknownRoute = !knownRoute(pathname);
  const title = unknownRoute
    ? "Page not found"
    : pathname === "/app/search"
      ? "Search"
      : pathname === "/app"
        ? "Overview"
        : /^\/app\/tasks\/[^/]+$/.test(pathname) &&
            pathname !== "/app/tasks/new"
          ? "Task workspace"
          : pathname === "/app/tasks"
            ? "All tasks"
            : pathname === "/app/tasks/new"
              ? "New task"
              : /^\/app\/assignments\/[^/]+\/recovery$/.test(pathname)
                ? "Recovery"
                : pathname === "/app/inbox"
                  ? "Inbox"
                  : pathname.startsWith("/app/settings") ||
                      pathname.endsWith("/settings")
                    ? "Settings"
                    : (project?.name ?? "Project");
  const query = path.includes("?") ? path.slice(path.indexOf("?")) : "";
  const inboxCount =
    (onInboxRoute ? inboxRouteSummary : inboxSummaryOf(inboxSummary.state))
      ?.count ?? null;
  // The task views put their intro and the one primary action in the page header.
  const taskRoute =
    pathname === "/app" || pathname === "/app/tasks" || Boolean(projectId);
  const newTaskHref = `/app/tasks/new${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`;
  const headerSubtitle = unknownRoute
    ? notFoundSubtitle
    : taskRoute
      ? projectId
        ? "Tasks in this project. Readiness, source status and execution are separate."
        : "Tasks across your projects. Action requests and ordinary progress remain distinct."
      : onInboxRoute && inboxRouteSummary
        ? `${inboxRouteSummary.count} unresolved across ${inboxRouteSummary.projects} project${inboxRouteSummary.projects === 1 ? "" : "s"}`
        : undefined;
  // The Inbox route refreshes its own list (and so the count) when the workspace read changes.
  const refreshAll = () => {
    workspace.refresh();
    if (!onInboxRoute) inboxSummary.refresh();
  };
  // These pages own a refresh that already re-reads their data.
  const ownsRefresh =
    unknownRoute ||
    pathname === "/app" ||
    pathname === "/app/tasks" ||
    Boolean(projectId) ||
    (/^\/app\/tasks\/[^/]+$/.test(pathname) && pathname !== "/app/tasks/new") ||
    (pathname === "/app/search" &&
      Boolean(new URLSearchParams(query).get("query")));
  const parent = unknownRoute
    ? null
    : parentRoute(pathname, query, workspace.state.data);
  // The Inbox reports its own subtitle, and on a phone its request-detail header.
  const { detail: inboxDetail, subtitle: inboxSubtitle } =
    (onInboxRoute && inboxHeader) || {};
  const inboxHeaderProps = inboxDetail
    ? {
        title: inboxDetail.title,
        subtitle: inboxDetail.subtitle,
        back: inboxDetail.back,
        menu: undefined,
        badge: undefined,
        action: inboxDetail.action,
      }
    : inboxSubtitle
      ? { subtitle: inboxSubtitle }
      : {};
  async function logout() {
    navigationScope.current = crypto.randomUUID();
    clearPrivateNavigation();
    client.invalidateAuthentication();
    acceptedIdentity.current = null;
    const isCurrentScope = client.captureAuthenticationScope();
    drafts.current.purge();
    taskStates.current.purge();
    questionStates.current.purge();
    inboxState.current.clear();
    searchState.current.clear();
    setLogoutPending(true);
    setLogoutNotice(null);
    try {
      await client.logout(session?.csrfToken ?? "");
    } catch (error) {
      if (
        isCurrentScope() &&
        error instanceof ClientError &&
        error.status !== 401
      )
        setLogoutNotice(
          "Sign-out outcome is unknown. Session status has been checked; review before retrying.",
        );
    } finally {
      if (isCurrentScope()) {
        setSession(null);
        setDrawer(false);
        setLogoutPending(false);
        setBootstrap((v) => v + 1);
      }
    }
  }
  const navigation = (row: boolean) => (
    <>
      <ProjectNavigation
        workspace={workspace.state.data}
        path={path}
        navigate={navigate}
        inboxCount={inboxCount}
        row={row}
      />
      {row ? (
        <AccountRows
          path={path}
          navigate={navigate}
          pending={logoutPending}
          onSignOut={() => void logout()}
        />
      ) : (
        <div className="account-footer">
          <AccountMenu
            key={navigationVersion}
            path={path}
            navigate={navigate}
            pending={logoutPending}
            onSignOut={() => void logout()}
          />
        </div>
      )}
    </>
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="workspace-header">
          <p className="body">Ensemble</p>
          <p className="metadata muted">Personal workspace</p>
        </div>
        {navigation(false)}
      </aside>
      <div className="workspace">
        <main className={onInboxRoute ? "page page-inbox" : "page"}>
          <PageHeader
            title={title}
            subtitle={headerSubtitle}
            plain={unknownRoute}
            badge={
              onInboxRoute && inboxCount !== null
                ? `${inboxCount} unresolved`
                : undefined
            }
            {...(parent
              ? { back: parent }
              : {
                  menu: (
                    <MobileNavigation open={drawer} onOpenChange={setDrawer}>
                      {navigation(true)}
                    </MobileNavigation>
                  ),
                })}
            action={
              taskRoute ? (
                <ActionLink variant="primary" href={newTaskHref}>
                  New task
                </ActionLink>
              ) : ownsRefresh ? undefined : (
                <Button
                  variant="secondary"
                  onClick={() => {
                    refreshAll();
                    if (pathname === "/app/inbox") tasks.refresh();
                  }}
                  disabled={workspace.state.pending}
                >
                  Refresh
                </Button>
              )
            }
            {...inboxHeaderProps}
          />
          {logoutNotice && (
            <p className="body error-text" role="alert">
              {logoutNotice}
            </p>
          )}
          {workspace.state.data?.data.runtime.state === "unavailable" && (
            <Alert variant="destructive" role="alert">
              Codex runtime unavailable — restart the service
            </Alert>
          )}
          {workspace.state.status !== "fresh" && (
            <ResourceStatus state={workspace.state} retry={workspace.refresh} />
          )}
          {unknownRoute ? (
            <NotFound />
          ) : pathname === "/app/settings/runtime" ? (
            <RuntimeSettings
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
            />
          ) : /^\/app\/assignments\/[^/]+\/recovery$/.test(pathname) ? (
            <AssignmentRecovery
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              assignmentId={pathname.split("/")[3] ?? ""}
            />
          ) : pathname === "/app/settings" ? (
            <SettingsWorkspace
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
            />
          ) : pathname === "/app/settings/projects/new" ? (
            <ProjectSetup
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
            />
          ) : pathname === "/app/settings/profiles/new" ||
            /^\/app\/profiles\/[^/]+\/settings$/.test(pathname) ? (
            <ProfileConfiguration
              key={pathname}
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              {...(pathname.includes("/profiles/") && !pathname.endsWith("/new")
                ? { profileId: pathname.split("/")[3] }
                : {})}
            />
          ) : /^\/app\/projects\/[^/]+\/settings$/.test(pathname) ? (
            <ProjectConfiguration
              key={pathname}
              client={client}
              session={session}
              drafts={drafts.current}
              workspace={workspace.state.data}
              refresh={workspace.refresh}
              projectId={pathname.split("/")[3] ?? ""}
            />
          ) : pathname === "/app/tasks/new" ? (
            <TaskComposer
              key={session.csrfToken}
              client={client}
              session={session}
              workspace={workspace.state.data}
              initialProject={
                new URLSearchParams(path.split("?")[1] ?? "").get("project") ??
                ""
              }
              onRecorded={tasks.refresh}
            />
          ) : pathname === "/app/inbox" ? (
            <Inbox
              client={client}
              session={session}
              path={path}
              navigate={navigate}
              state={inboxState.current}
              questions={questionStates.current}
              observation={workspace.state.data}
              onSummary={setInboxRouteSummary}
              onHeader={setInboxHeader}
            />
          ) : pathname === "/app/search" ? (
            <Search
              key={`${session.csrfToken}:${entryKey}`}
              client={client}
              session={session}
              workspace={workspace.state.data}
              path={path}
              navigate={navigate}
              onRefresh={refreshAll}
              state={activeSearch}
            />
          ) : /^\/app\/tasks\/[^/]+$/.test(pathname) ? (
            <TaskWorkspace
              key={`${session.csrfToken}:${entryKey}`}
              client={client}
              session={session}
              taskId={pathname.split("/")[3] ?? ""}
              path={path}
              onRefresh={refreshAll}
              questionStates={questionStates.current}
              state={taskStates.current.forTask(
                pathname.split("/")[3] ?? "",
                entryKey,
              )}
            />
          ) : (
            <TaskViews
              state={tasks.state}
              refresh={() => {
                tasks.refresh();
                refreshAll();
              }}
              workspace={workspace.state.data}
              path={path}
              navigate={navigate}
              {...(projectId ? { projectId } : {})}
              overview={pathname === "/app"}
            />
          )}
        </main>
      </div>
    </div>
  );
}
