import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import SetupWizard from "./SetupWizard";
import { renderWithProviders } from "@/test/render";

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

describe("SetupWizard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders in create mode by default", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: false,
          defaults: {},
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard />, { route: "/config" });

    // Should show create mode title
    expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();
    
    // Should show step indicators
    expect(screen.getByText("Tracker")).toBeInTheDocument();
    expect(screen.getByText("Repositories")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();
  });

  it("renders in reconfigure mode", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/api/v1/config/setup/defaults")) {
        return jsonResponse({
          has_existing_config: true,
          defaults: {
            tracker: { kind: "git_hub", repository: "owner/repo", projectNumber: 1 },
            repos: [{ path: "/existing/repo", branch: "develop" }],
            agents: [{ role: "implement", acpxAgent: "builder", model: "gpt-4" }],
          },
        });
      }
      return jsonResponse({});
    }));

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });

    // Should show reconfigure mode title
    expect(await screen.findByText("Reconfigure Ensemble")).toBeInTheDocument();
  });

  it("shows loading state in reconfigure mode", async () => {
    // Mock with delay to show loading
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // Never resolves

    renderWithProviders(<SetupWizard mode="reconfigure" />, { route: "/config" });

    // Should show loading message
    expect(await screen.findByText(/loading existing configuration/i)).toBeInTheDocument();
  });
});
