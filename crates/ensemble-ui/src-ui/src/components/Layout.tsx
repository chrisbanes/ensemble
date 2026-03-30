import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getTheme, toggleTheme } from "../theme";
import type { Theme } from "../theme";
import NotificationPanel from "./NotificationPanel";
import { getUnreadCount, subscribe } from "../notifications";

const navItems = [
  { to: "/", label: "Dashboard" },
  { to: "/history", label: "History" },
  { to: "/config", label: "Config" },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return isActive
    ? "px-3 py-2 rounded-md text-sm font-medium bg-gray-900 text-white dark:bg-gray-700"
    : "px-3 py-2 rounded-md text-sm font-medium text-gray-300 hover:bg-gray-700 hover:text-white";
}

export default function Layout() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [unreadCount, setUnreadCount] = useState(getUnreadCount);
  const [showNotifications, setShowNotifications] = useState(false);

  useEffect(() => {
    return subscribe(() => setUnreadCount(getUnreadCount()));
  }, []);

  function handleToggleTheme() {
    const next = toggleTheme();
    setThemeState(next);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="bg-gray-800 shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-14">
            <div className="flex items-center gap-4">
              <span className="text-white font-bold text-lg">Ensemble</span>
              <div className="flex items-center gap-1">
                {navItems.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navLinkClass}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              {/* Notification bell */}
              <button
                onClick={() => setShowNotifications((prev) => !prev)}
                className="relative p-2 rounded-md text-gray-300 hover:text-white hover:bg-gray-700"
                aria-label="Notifications"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </button>

              {/* Theme toggle */}
              <button
                onClick={handleToggleTheme}
                className="p-2 rounded-md text-gray-300 hover:text-white hover:bg-gray-700"
                aria-label="Toggle theme"
              >
                {theme === "dark" ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Notification panel dropdown */}
      <NotificationPanel open={showNotifications} onClose={() => setShowNotifications(false)} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
