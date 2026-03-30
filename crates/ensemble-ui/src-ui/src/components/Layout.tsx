import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { Bell, Sun, Moon } from "lucide-react";
import { getTheme, toggleTheme } from "@/theme";
import type { Theme } from "@/theme";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import NotificationPanel from "./NotificationPanel";
import { getUnreadCount, subscribe } from "@/notifications";
import { cn } from "@/lib/utils";

const navItems = [
  { to: "/", label: "Dashboard" },
  { to: "/history", label: "History" },
  { to: "/config", label: "Config" },
];

function navLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    "px-3 py-2 rounded-md text-sm font-medium transition-colors",
    isActive
      ? "bg-gray-900 text-white dark:bg-gray-700"
      : "text-gray-300 hover:bg-gray-700 hover:text-white",
  );
}

export default function Layout() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [unreadCount, setUnreadCount] = useState(getUnreadCount);

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

            <div className="flex items-center gap-1">
              <Popover>
                <PopoverTrigger
                  render={
                    <Button variant="ghost" size="icon" className="relative text-gray-300 hover:text-white hover:bg-gray-700" />
                  }
                >
                  <Bell className="h-5 w-5" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full">
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </PopoverTrigger>
                <PopoverContent align="end" className="w-96 p-0">
                  <NotificationPanel />
                </PopoverContent>
              </Popover>

              <Button variant="ghost" size="icon" onClick={handleToggleTheme} className="text-gray-300 hover:text-white hover:bg-gray-700">
                {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </div>
      </nav>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
