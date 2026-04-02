import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import ConfigPage from "./ConfigPage";
import { renderWithProviders } from "@/test/render";

function jsonResponse(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);
}

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows setup mode when the config state is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      state: "missing",
      config_path: "/tmp/ensemble/config.yaml",
      raw_yaml: null,
      issues: [],
      active_config: null,
    })));

    renderWithProviders(<ConfigPage />, { route: "/config" });

    expect(await screen.findByText("Set up Ensemble")).toBeInTheDocument();
  });
});
