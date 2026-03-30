export class FetchError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      (body as Record<string, Record<string, string>>)?.error?.message ??
      `HTTP ${status}`;
    super(message);
    this.name = "FetchError";
    this.status = status;
    this.body = body;
  }
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
