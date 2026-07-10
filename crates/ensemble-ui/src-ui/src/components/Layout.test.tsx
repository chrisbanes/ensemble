import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppNotification } from "@/notification-types";
import Layout from "./Layout";

let mockConfigData:
  | {
      state: string;
      active_config: object | null;
      issues: unknown[];
    }
  | undefined;
let mockUnreadCount = 0;
let mockNotifications: AppNotification[] = [];
const notificationListeners = new Set<() => void>();

vi.mock("@/hooks", () => ({
  useConfigStateQuery: () => ({ data: mockConfigData }),
}));

vi.mock("@/notifications", () => ({
  getNotifications: () => mockNotifications,
  getUnreadCount: () => mockUnreadCount,
  markAllRead: vi.fn(),
  subscribe: (listener: () => void) => {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  },
}));

vi.mock("@/theme", () => ({
  getTheme: () => "light",
  toggleTheme: () => "dark",
}));

function renderLayout(initialEntry = "/config") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<section>Dashboard content</section>} />
          <Route path="/history" element={<section>History content</section>} />
          <Route path="/config" element={<section>Config content</section>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function desktopNavigation() {
  return within(screen.getByRole("navigation", { name: "Desktop navigation" }));
}

function mobileNavigation() {
  return within(screen.getByRole("navigation", { name: "Mobile navigation" }));
}

describe("Layout", () => {
  beforeEach(() => {
    mockConfigData = undefined;
    mockUnreadCount = 0;
    mockNotifications = [];
    notificationListeners.clear();
  });

  it("renders operational routes as non-link disabled items when configuration is not runnable", () => {
    renderLayout();

    expect(desktopNavigation().queryByRole("link", { name: "Mission Control" })).not.toBeInTheDocument();
    expect(mobileNavigation().queryByRole("link", { name: "History" })).not.toBeInTheDocument();

    for (const navigation of [desktopNavigation(), mobileNavigation()]) {
      const missionControlItem = navigation.getByLabelText("Mission Control");
      const historyItem = navigation.getByLabelText("History");
      expect(missionControlItem).toHaveAttribute("aria-disabled", "true");
      expect(missionControlItem).not.toHaveAttribute("href");
      expect(historyItem).toHaveAttribute("aria-disabled", "true");
      expect(historyItem).not.toHaveAttribute("href");
      expect(navigation.getByRole("link", { name: "Config" })).toHaveAttribute("href", "/config");
    }
  });

  it("allows pointer and keyboard navigation when configuration is runnable", async () => {
    const user = userEvent.setup();
    mockConfigData = { state: "parsed", active_config: {}, issues: [] };
    renderLayout();

    const historyLink = desktopNavigation().getByRole("link", { name: "History" });
    expect(historyLink).not.toHaveAttribute("aria-disabled");
    historyLink.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByText("History content")).toBeInTheDocument();

    await user.click(mobileNavigation().getByRole("link", { name: "Mission Control" }));
    expect(screen.getByText("Dashboard content")).toBeInTheDocument();
  });

  it("updates utility labels with notification and theme state", async () => {
    const user = userEvent.setup();
    mockNotifications = [
      {
        id: "notification-1",
        severity: "info",
        title: "Agent update",
        detail: "Review completed",
        timestamp: "2026-07-09T09:30:00Z",
        issue_identifier: "repo#1",
        read: false,
      },
    ];
    renderLayout();

    expect(screen.getAllByRole("button", { name: "Notifications" })).toHaveLength(2);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    act(() => {
      mockUnreadCount = 3;
      notificationListeners.forEach((listener) => listener());
    });

    expect(screen.getAllByRole("button", { name: "Notifications (3 unread)" })).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("3 unread notifications");

    await user.click(mobileNavigation().getByRole("button", { name: "Notifications (3 unread)" }));
    const popover = document.querySelector('[data-slot="popover-content"]');
    expect(popover).toHaveClass(
      "w-[min(24rem,calc(100vw-2rem))]",
      "max-h-[var(--available-height)]",
      "overflow-hidden",
    );
    const notificationList = screen.getByRole("list");
    expect(notificationList.parentElement).toHaveClass("flex", "min-h-0", "flex-1", "flex-col");
    expect(notificationList).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");

    act(() => {
      mockUnreadCount = 0;
      notificationListeners.forEach((listener) => listener());
    });

    expect(screen.getAllByRole("button", { name: "Notifications" })).toHaveLength(2);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("No unread notifications");

    await user.click(mobileNavigation().getByRole("button", { name: "Switch to dark theme" }));
    expect(screen.getAllByRole("button", { name: "Switch to light theme" })).toHaveLength(2);
  });

  it("constrains the shell and keeps only main content scrollable", () => {
    const { container } = renderLayout();

    expect(container.firstElementChild).toHaveClass(
      "flex",
      "h-dvh",
      "min-h-0",
      "overflow-hidden",
      "bg-background",
      "text-foreground",
    );
    expect(screen.getByRole("complementary")).toHaveClass("hidden", "w-16", "md:flex");
    expect(screen.getByRole("navigation", { name: "Mobile navigation" })).toHaveClass(
      "overflow-hidden",
      "px-2",
      "sm:px-4",
      "md:hidden",
    );

    const main = screen.getByRole("main");
    expect(main.parentElement).toHaveClass("min-h-0", "min-w-0", "flex-1");
    expect(main).toHaveClass("min-h-0", "flex-1", "overflow-auto");
    expect(container.querySelectorAll("main")).toHaveLength(1);
  });
});
