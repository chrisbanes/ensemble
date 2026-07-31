export class FetchError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const message = responseMessage(body) ?? `HTTP ${status}`;
    super(message);
    this.name = "FetchError";
    this.status = status;
    this.body = body;
  }
}

function responseMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const response = body as Record<string, unknown>;
  if (response.error && typeof response.error === "object") {
    const message = (response.error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }

  if (Array.isArray(response.issues)) {
    for (const issue of response.issues) {
      if (issue && typeof issue === "object") {
        const message = (issue as Record<string, unknown>).message;
        if (typeof message === "string") {
          return message;
        }
      }
    }
  }

  return undefined;
}

export const customFetch = async <T>(
  url: string,
  options?: RequestInit,
): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // response was not JSON
    }
    throw new FetchError(res.status, body);
  }

  const data = await res.json();
  // Return value matches orval's expected response structure (includes data, status, headers)
  return { data, status: res.status, headers: res.headers } as T;
};
