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
});
