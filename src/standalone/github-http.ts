export const githubApi = "https://api.github.com";
const maxRedirects = 3;
const redirects = new Set([301, 302, 303, 307, 308]);

/**
 * One GitHub API request. A non-GET never follows a redirect; a GET follows at
 * most three, each of which must stay on the API origin. Anything else is the
 * caller's `refused` error, so each client keeps its own error vocabulary.
 */
export async function githubFetch(
  fetcher: typeof fetch,
  href: string,
  init: RequestInit & { method: string },
  refused: () => Error,
): Promise<Response> {
  const get = init.method === "GET";
  let target = new URL(href);
  for (let hop = 0; ; hop++) {
    if (target.origin !== githubApi) throw refused();
    const response = await fetcher(target.href, {
      ...init,
      redirect: get ? "manual" : "error",
    });
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== githubApi)
    )
      throw refused();
    if (!redirects.has(response.status)) return response;
    const location = response.headers.get("location");
    if (!get || !location || hop >= maxRedirects) throw refused();
    await response.body?.cancel();
    target = new URL(location, target);
  }
}

/** The `rel="next"` URL of a Link header, or null when there is no next page. */
export function nextPageLink(
  response: Response,
  malformed: () => Error,
): string | null {
  const next = response.headers
    .get("link")
    ?.split(",")
    .find((part) => /;\s*rel="next"/.test(part));
  if (!next) return null;
  const match = /<([^>]+)>/.exec(next);
  if (!match?.[1]) throw malformed();
  return new URL(match[1], githubApi).href;
}
