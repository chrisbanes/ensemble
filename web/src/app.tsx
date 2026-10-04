import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
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
  TextField,
  StatusBadge,
  ResourceStatus,
  MobileNavigation,
} from "./components.js";
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
import { TaskWorkspace, TaskInbox } from "./task-workspace.js";
import { TaskWorkspaceStates } from "./task-workspace-state.js";
import { TaskViews } from "./task-views.js";
function RouteLink({
  href,
  path,
  navigate,
  children,
}: {
  href: string;
  path: string;
  navigate: (path: string) => void;
  children: ReactNode;
}) {
  return (
    <a
      className="control nav-link"
      href={href}
      aria-current={path.split("?")[0] === href ? "page" : undefined}
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
      {children}
    </a>
  );
}
function ProjectNavigation({
  workspace,
  path,
  navigate,
}: {
  workspace: Workspace | null;
  path: string;
  navigate: (path: string) => void;
}) {
  return (
    <nav aria-label="Operator navigation">
      <RouteLink href="/app" path={path} navigate={navigate}>
        Overview
      </RouteLink>
      <RouteLink href="/app/inbox" path={path} navigate={navigate}>
        Inbox
      </RouteLink>
      <RouteLink href="/app/tasks" path={path} navigate={navigate}>
        All tasks
      </RouteLink>
      <RouteLink href="/app/search" path={path} navigate={navigate}>
        Search
      </RouteLink>
      <h2 className="small-heading">Projects</h2>
      {workspace?.data.projects.length === 0 && (
        <p className="body muted">No projects yet.</p>
      )}
      {workspace?.data.projects.map((p) => (
        <RouteLink
          key={p.id}
          href={`/app/projects/${p.id}`}
          path={path}
          navigate={navigate}
        >
          <span>{p.name ?? "Name unavailable"}</span>
          {p.paused && <StatusBadge tone="warning">Paused</StatusBadge>}
        </RouteLink>
      ))}
      <RouteLink href="/app/settings" path={path} navigate={navigate}>
        Settings
      </RouteLink>
      <a className="control nav-link" href="/">
        Existing operator controls
      </a>
    </nav>
  );
}
export function Login({
  client,
  session,
  onSignedIn,
}: {
  client: OperatorClient;
  session: Session;
  onSignedIn: (s: Session) => void;
}) {
  const [password, setPassword] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(false);
    try {
      onSignedIn(await client.login(password, session.csrfToken));
      setPassword("");
    } catch {
      setError(true);
      setPassword("");
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="login">
      <div className="login-content">
        <p className="wordmark feature-heading">Ensemble</p>
        <h1 className="page-heading">Sign in</h1>
        <p className="introduction muted">Your operator workspace.</p>
        <form onSubmit={submit}>
          <TextField
            label="Password"
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={pending}
          />
          {error && (
            <p className="body error-text" role="alert">
              Sign in failed. Try again.
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
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
    [logoutNotice, setLogoutNotice] = useState<string | null>(null);
  const searchState = useRef(new Map<string, SearchState>());
  const taskStates = useRef(new TaskWorkspaceStates());
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation purge uses current browser entry and stable scope ref.
  const expired = useCallback(() => {
    navigationScope.current = crypto.randomUUID();
    clearPrivateNavigation();
    clientRef.current?.invalidateAuthentication();
    acceptedIdentity.current = null;
    setLogoutPending(false);
    drafts.current.purge();
    taskStates.current.purge();
    searchState.current.clear();
    setSession(null);
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
  const pathname = path.split("?")[0] ?? "/app";
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
      <main className="login">
        <div className="login-content">
          <h1 className="page-heading">Ensemble</h1>
          {bootstrapError ? (
            <>
              <p role="alert" className="body">
                Sign-in service unavailable.
              </p>
              <Button onClick={() => setBootstrap((v) => v + 1)}>
                Try again
              </Button>
            </>
          ) : (
            <p role="status" className="body">
              Loading sign-in…
            </p>
          )}
        </div>
      </main>
    );
  if (!session.authenticated)
    return (
      <>
        <Login
          key={session.csrfToken}
          client={client}
          session={session}
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
  const projectId = pathname.match(/^\/app\/projects\/([^/]+)$/)?.[1];
  const project = workspace.state.data?.data.projects.find(
    (p) => p.id === projectId,
  );
  const title =
    pathname === "/app/search"
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
                    : projectId
                      ? (project?.name ?? "Project")
                      : "Page not found";
  const destination =
    projectId && project
      ? `/project/${project.id}`
      : pathname === "/app/inbox"
        ? "/coordination"
        : "/";
  const description =
    pathname === "/app/inbox"
      ? "Questions, approvals and task coordination are available in the existing operator."
      : pathname === "/app/settings"
        ? "Project, profile, routing and source settings are available in the existing operator."
        : projectId
          ? "Task and project controls are available in the existing operator."
          : "Choose a project to open its current controls.";
  async function logout() {
    navigationScope.current = crypto.randomUUID();
    clearPrivateNavigation();
    client.invalidateAuthentication();
    acceptedIdentity.current = null;
    const isCurrentScope = client.captureAuthenticationScope();
    drafts.current.purge();
    taskStates.current.purge();
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
  const nav = (
    <ProjectNavigation
      workspace={workspace.state.data}
      path={path}
      navigate={navigate}
    />
  );
  return (
    <div className="shell">
      <aside className="sidebar">
        <p className="wordmark feature-heading">Ensemble</p>
        {nav}
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="phone-nav">
            <MobileNavigation open={drawer} onOpenChange={setDrawer}>
              {nav}
            </MobileNavigation>
          </div>
          <p className="body muted desktop-context">Operator workspace</p>
          <Button
            variant="secondary"
            disabled={logoutPending}
            onClick={() => void logout()}
          >
            {logoutPending ? "Signing out…" : "Sign out"}
          </Button>
        </header>
        <main className="page">
          <div className="page-title">
            <h1 className="page-heading">{title}</h1>
            <Button
              variant="secondary"
              onClick={workspace.refresh}
              disabled={workspace.state.pending}
            >
              Refresh
            </Button>
          </div>
          {logoutNotice && (
            <p className="body error-text" role="alert">
              {logoutNotice}
            </p>
          )}
          {workspace.state.status !== "fresh" && (
            <ResourceStatus state={workspace.state} retry={workspace.refresh} />
          )}
          {pathname === "/app/settings/runtime" ? (
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
            <TaskInbox
              client={client}
              session={session}
              ids={
                tasks.state.data?.tasks
                  .filter((t) => t.attention.count > 0)
                  .map((t) => t.id) ?? []
              }
            />
          ) : pathname === "/app/search" ? (
            <Search
              key={`${session.csrfToken}:${entryKey}`}
              client={client}
              session={session}
              workspace={workspace.state.data}
              path={path}
              navigate={navigate}
              state={activeSearch}
            />
          ) : /^\/app\/tasks\/[^/]+$/.test(pathname) ? (
            <TaskWorkspace
              key={`${session.csrfToken}:${pathname}`}
              client={client}
              session={session}
              taskId={pathname.split("/")[3] ?? ""}
              path={path}
              state={taskStates.current.forTask(pathname.split("/")[3] ?? "")}
            />
          ) : pathname === "/app" || pathname === "/app/tasks" || projectId ? (
            <TaskViews
              state={tasks.state}
              refresh={tasks.refresh}
              workspace={workspace.state.data}
              path={path}
              navigate={navigate}
              {...(projectId ? { projectId } : {})}
              overview={pathname === "/app"}
            />
          ) : (
            <>
              <p className="introduction muted">{description}</p>
              <ActionLink
                variant="primary"
                className="action-link"
                href={destination}
              >
                Open existing{" "}
                {pathname === "/app/inbox"
                  ? "coordination controls"
                  : "operator controls"}
              </ActionLink>
              <p className="metadata muted">
                Task detail, complete Inbox and settings controls remain
                available in the existing operator.
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
