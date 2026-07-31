import { afterEach, describe, expect, it, vi } from "vitest";

import { customFetch } from "./fetch-client";

describe("customFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the default Accept header when callers provide custom headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await customFetch<{ data: { ok: boolean } }>("/api/test", {
      headers: { Authorization: "Bearer token" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    const headers = new Headers(options?.headers);

    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer token");
  });

  it("uses config response issues as the error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            issues: [
              {
                section: "runtime",
                message: "Configuration saved; restart Ensemble to apply it",
              },
            ],
          }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const request = customFetch("/api/v1/config/yaml/save", { method: "POST" });

    await expect(request).rejects.toMatchObject({
      status: 409,
      message: "Configuration saved; restart Ensemble to apply it",
    });
  });
});
