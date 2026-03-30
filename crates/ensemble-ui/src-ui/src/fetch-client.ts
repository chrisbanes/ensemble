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
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options,
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
  return { data, status: res.status, headers: res.headers } as T;
};
