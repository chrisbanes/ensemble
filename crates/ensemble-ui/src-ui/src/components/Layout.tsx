import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Bell, Gauge, History, Moon, Settings, Sun } from "lucide-react";
import { getTheme, toggleTheme } from "@/theme";
import type { Theme } from "@/theme";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import NotificationPanel from "./NotificationPanel";
import { getUnreadCount, subscribe } from "@/notifications";
import { cn } from "@/lib/utils";
import { useConfigStateQuery } from "@/hooks";

function navIconClass({ isActive }: { isActive: boolean }, disabled = false) {
  return cn(
    "mb-2 flex h-10 w-10 items-center justify-center rounded-lg text-xs font-semibold transition-colors",
    isActive
      ? "bg-primary text-primary-foreground"
      : cn("text-muted-foreground", !disabled && "hover:bg-muted hover:text-foreground"),
    disabled && "cursor-not-allowed opacity-50",
  );
}

function navLinkClass({ isActive }: { isActive: boolean }, disabled = false) {
  return cn(
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-medium transition-colors sm:w-auto sm:gap-2 sm:px-3",
    isActive
      ? "bg-primary text-primary-foreground"
      : cn("text-muted-foreground", !disabled && "hover:bg-muted hover:text-foreground"),
    disabled && "cursor-not-allowed opacity-50",
  );
}

interface GatedNavItemProps {
  children: ReactNode;
  className: (props: { isActive: boolean }) => string;
  disabled: boolean;
  end?: boolean;
  label: string;
  to: string;
}

function GatedNavItem({
  children,
  className,
  disabled,
  end,
  label,
  to,
}: GatedNavItemProps) {
  if (disabled) {
    return (
      <span aria-disabled="true" aria-label={label} className={className({ isActive: false })}>
        {children}
      </span>
    );
  }

  return (
    <NavLink to={to} end={end} aria-label={label} className={className}>
      {children}
    </NavLink>
  );
}

export default function Layout() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [unreadCount, setUnreadCount] = useState(getUnreadCount);
  const previousUnreadCount = useRef(unreadCount);
  const [notificationAnnouncement, setNotificationAnnouncement] = useState(
    unreadCount > 0 ? `${unreadCount} unread notifications` : "",
  );
  const { data: configData } = useConfigStateQuery();

  // Parsed config state with no validation issues is runnable. The API does not
  // expose the resolved runtime config because it may contain secrets.
  const isConfigRunnable = configData
    ? configData.state === "parsed" && configData.issues.length === 0
    : false;
  const notificationLabel =
    unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications";

  useEffect(() => {
    return subscribe(() => {
      const nextUnreadCount = getUnreadCount();
      setUnreadCount(nextUnreadCount);
      if (nextUnreadCount > 0) {
        setNotificationAnnouncement(`${nextUnreadCount} unread notifications`);
      } else if (previousUnreadCount.current > 0) {
        setNotificationAnnouncement("No unread notifications");
      }
      previousUnreadCount.current = nextUnreadCount;
    });
  }, []);

  function handleToggleTheme() {
    const next = toggleTheme();
    setThemeState(next);
  }

  function renderUtilityActions(className?: string) {
    return (
      <div className={cn("flex shrink-0 items-center gap-1", className)}>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={notificationLabel}
              />
            }
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-xs font-bold text-white">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="max-h-[var(--available-height)] w-[min(24rem,calc(100vw-2rem))] overflow-hidden p-0"
          >
            <NotificationPanel />
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="icon"
          onClick={handleToggleTheme}
          className="text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notificationAnnouncement}
      </span>
      <aside className="hidden min-h-0 w-16 shrink-0 flex-col items-center border-r bg-card px-2 py-3 md:flex">
        <nav aria-label="Desktop navigation" className="flex flex-col items-center">
          <GatedNavItem
            to="/"
            end
            disabled={!isConfigRunnable}
            className={(props) => navIconClass(props, !isConfigRunnable)}
            label="Mission Control"
          >
            MC
          </GatedNavItem>
          <GatedNavItem
            to="/history"
            disabled={!isConfigRunnable}
            className={(props) => navIconClass(props, !isConfigRunnable)}
            label="History"
          >
            H
          </GatedNavItem>
          <NavLink to="/config" className={navIconClass} aria-label="Config">
            C
          </NavLink>
        </nav>
        <div className="flex-1" />
        {renderUtilityActions("flex-col")}
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <nav
          aria-label="Mobile navigation"
          className="flex h-14 shrink-0 items-center justify-between overflow-hidden border-b bg-card px-2 sm:px-4 md:hidden"
        >
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <span className="hidden shrink-0 text-lg font-bold text-foreground sm:inline">
              Ensemble
            </span>
            <div className="flex min-w-0 items-center gap-1">
              <GatedNavItem
                to="/"
                end
                disabled={!isConfigRunnable}
                className={(props) => navLinkClass(props, !isConfigRunnable)}
                label="Mission Control"
              >
                <Gauge className="h-4 w-4" />
                <span className="hidden sm:inline">Mission Control</span>
              </GatedNavItem>
              <GatedNavItem
                to="/history"
                disabled={!isConfigRunnable}
                className={(props) => navLinkClass(props, !isConfigRunnable)}
                label="History"
              >
                <History className="h-4 w-4" />
                <span className="hidden sm:inline">History</span>
              </GatedNavItem>
              <NavLink to="/config" className={navLinkClass} aria-label="Config">
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Config</span>
              </NavLink>
            </div>
          </div>
          {renderUtilityActions()}
        </nav>

        <main className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
