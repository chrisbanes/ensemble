// Test-only input for the scripted provider; production tools still validate it.
export function parseToolArguments(input: string): Record<string, unknown> {
  const directives = [...input.matchAll(/(?:^|\s)tool_args:([^\s]*)/gu)];
  if (directives.length === 0) return {};
  if (directives.length !== 1)
    throw new Error("Expected one tool_args directive");
  const encoded = directives[0]?.[1] ?? "";
  if (encoded.length > 65536) throw new Error("tool_args exceeds size limit");
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded))
    throw new Error("Invalid tool_args encoding");
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded)
    throw new Error("Non-canonical tool_args encoding");
  const value: unknown = JSON.parse(decoded.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("tool_args must encode a JSON object");
  return value as Record<string, unknown>;
}
