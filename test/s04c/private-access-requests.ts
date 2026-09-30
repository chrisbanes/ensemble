import type { APIRequestContext, APIResponse } from "playwright";

type PostOptions = NonNullable<Parameters<APIRequestContext["post"]>[1]>;

export function postWithoutFollowingRedirects(
  request: APIRequestContext,
  url: string,
  options: PostOptions,
): Promise<APIResponse> {
  return request.post(url, { ...options, maxRedirects: 0 });
}
