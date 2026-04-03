import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FileBrowser from "./FileBrowser";
import { renderWithProviders } from "@/test/render";

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

function jsonErrorResponse(status: number, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: { code: "test_error", message } }),
  } as Response);
}

describe("FileBrowser", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders dialog when open", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({ entries: [], truncated: false })));

    renderWithProviders(
      <FileBrowser
        mode="file"
        onSelect={() => {}}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByText("Select a File")).toBeInTheDocument();
  });

  it("does not render dialog when closed", () => {
    vi.stubGlobal("fetch", vi.fn());

    renderWithProviders(
      <FileBrowser
        mode="file"
        onSelect={() => {}}
        open={false}
        onOpenChange={() => {}}
      />,
    );

    expect(screen.queryByText("Select a File")).not.toBeInTheDocument();
  });

  it("shows loading state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    renderWithProviders(
      <FileBrowser
        mode="file"
        onSelect={() => {}}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state", async () => {
    vi.stubGlobal("fetch", vi.fn(() =>
      jsonErrorResponse(500, "Internal server error"),
    ));

    renderWithProviders(
      <FileBrowser
        mode="file"
        onSelect={() => {}}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    expect(await screen.findByText("Internal server error")).toBeInTheDocument();
  });

  it("breadcrumb navigation works", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("path=%2F") && !url.includes("path=%2Fhome")) {
        return jsonResponse({
          entries: [
            { name: "home", is_dir: true, path: "/home" },
          ],
          truncated: false,
        });
      }
      if (url.includes("path=%2Fhome")) {
        return jsonResponse({
          entries: [
            { name: "user", is_dir: true, path: "/home/user" },
          ],
          truncated: false,
        });
      }
      return jsonResponse({ entries: [], truncated: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(
      <FileBrowser
        mode="directory"
        onSelect={() => {}}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    // Wait for initial load
    expect(await screen.findByText("home")).toBeInTheDocument();

    // Navigate into /home by double-clicking the list item
    const homeItem = screen.getByText("home");
    await user.dblClick(homeItem);

    // Wait for navigation - should show /home contents
    await waitFor(() => {
      expect(screen.getByText("user")).toBeInTheDocument();
    }, { timeout: 2000 });

    // Verify breadcrumb shows / and home
    expect(screen.getByText("home")).toBeInTheDocument();

    // Click root breadcrumb to go back
    const rootBreadcrumb = screen.getAllByText("/")[0];
    expect(rootBreadcrumb).toBeDefined();
    await user.click(rootBreadcrumb!);

    // Should be back at root
    await waitFor(() => {
      expect(screen.getByText("home")).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it("selection works in file mode", async () => {
    const user = userEvent.setup();
    const selectMock = vi.fn();
    const openChangeMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({
      entries: [
        { name: "src", is_dir: true, path: "/home/user/src" },
        { name: "config.yaml", is_dir: false, path: "/home/user/config.yaml" },
      ],
      truncated: false,
    })));

    renderWithProviders(
      <FileBrowser
        mode="file"
        onSelect={selectMock}
        open={true}
        onOpenChange={openChangeMock}
      />,
    );

    // Wait for entries to load
    expect(await screen.findByText("config.yaml")).toBeInTheDocument();

    // In file mode, directories are shown but not selectable
    // Click the file to select it
    await user.click(screen.getByText("config.yaml"));

    // Select button should now be enabled
    const selectButton = screen.getByRole("button", { name: "Select" });
    expect(selectButton).toBeEnabled();

    // Click Select
    await user.click(selectButton);

    // onSelect should be called with the file path
    expect(selectMock).toHaveBeenCalledWith("/home/user/config.yaml");
    expect(openChangeMock).toHaveBeenCalledWith(false);
  });

  it("selection works in directory mode", async () => {
    const user = userEvent.setup();
    const selectMock = vi.fn();
    const openChangeMock = vi.fn();

    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({
      entries: [
        { name: "src", is_dir: true, path: "/home/user/src" },
        { name: "config.yaml", is_dir: false, path: "/home/user/config.yaml" },
      ],
      truncated: false,
    })));

    renderWithProviders(
      <FileBrowser
        mode="directory"
        onSelect={selectMock}
        open={true}
        onOpenChange={openChangeMock}
      />,
    );

    // Wait for entries to load - in directory mode only dirs are shown
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.queryByText("config.yaml")).not.toBeInTheDocument();

    // Click the directory to select it
    await user.click(screen.getByText("src"));

    // Select button should now be enabled
    const selectButton = screen.getByRole("button", { name: "Select" });
    expect(selectButton).toBeEnabled();

    // Click Select
    await user.click(selectButton);

    // onSelect should be called with the directory path
    expect(selectMock).toHaveBeenCalledWith("/home/user/src");
    expect(openChangeMock).toHaveBeenCalledWith(false);
  });

  it("Select button is disabled when nothing is selected", async () => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse({
      entries: [
        { name: "src", is_dir: true, path: "/home/user/src" },
      ],
      truncated: false,
    })));

    renderWithProviders(
      <FileBrowser
        mode="directory"
        onSelect={() => {}}
        open={true}
        onOpenChange={() => {}}
      />,
    );

    // Wait for entries to load
    expect(await screen.findByText("src")).toBeInTheDocument();

    // Select button should be disabled
    const selectButton = screen.getByRole("button", { name: "Select" });
    expect(selectButton).toBeDisabled();
  });
});
