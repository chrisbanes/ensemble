export type OperatorRouteResult =
  | { kind: "html"; body: string }
  | { kind: "redirect"; location: string };

export type OperatorRouteContext = {
  params: Readonly<Record<string, string>>;
  fields: Readonly<Record<string, string>>;
  csrfToken: string;
  webEnabled?: boolean;
};

export type OperatorRouteHandler = (
  context: OperatorRouteContext,
) => OperatorRouteResult | Promise<OperatorRouteResult>;

export type OperatorRoute = {
  method: "GET" | "POST";
  path: string;
  handler: OperatorRouteHandler;
};

export type OperatorRouteSlot = "runtime" | "coordination";

type RegisteredRoute = OperatorRoute & {
  segments: string[];
};

function containsControlCharacters(value: string): boolean {
  return value.split("").some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

const RESERVED_ROOTS = new Set([
  "login",
  "logout",
  "command",
  "project",
  "task",
  "profile",
  "assignment",
  "runtime",
  "coordination",
]);

function parseRoutePath(path: string, slot?: OperatorRouteSlot): string[] {
  if (path === "/") throw new Error("Operator route path is reserved");
  if (
    !path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("%") ||
    path.includes("\\")
  ) {
    throw new Error("Invalid operator route path");
  }
  const segments = path.slice(1).split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        !(
          /^[a-z][a-z0-9-]*$/.test(segment) ||
          /^:[A-Za-z][A-Za-z0-9]*$/.test(segment)
        ),
    )
  ) {
    throw new Error("Invalid operator route path");
  }
  if (
    segments[0]?.startsWith(":") ||
    (RESERVED_ROOTS.has(segments[0]?.toLowerCase() ?? "") &&
      segments[0] !== slot)
  ) {
    throw new Error("Operator route path is reserved");
  }
  return segments;
}

function routesOverlap(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index];
      return (
        segment?.startsWith(":") || other?.startsWith(":") || segment === other
      );
    })
  );
}

function decodeSegment(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      containsControlCharacters(decoded)
    ) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

/** Pre-start, typed route seam for trusted Ensemble UI extensions. */
export class OperatorRouteRegistry {
  private readonly routes: RegisteredRoute[] = [];
  private readonly slots = new Map<OperatorRouteSlot, RegisteredRoute[]>();
  private started = false;

  register(route: OperatorRoute): void {
    if (this.started) throw new Error("Operator routes are already mounted");
    this.routes.push(this.validateRoute(route));
  }

  registerSlot(slot: OperatorRouteSlot, routes: OperatorRoute[]): void {
    if (this.started) throw new Error("Operator routes are already mounted");
    if (slot !== "runtime" && slot !== "coordination")
      throw new Error("Invalid operator route slot");
    if (this.slots.has(slot))
      throw new Error("Operator route slot already registered");
    if (!Array.isArray(routes) || routes.length === 0)
      throw new Error("Operator route slot must contain routes");

    const registered: RegisteredRoute[] = [];
    for (const route of routes) {
      const item = this.validateRoute(route, slot);
      if (item.segments[0] !== slot)
        throw new Error(`Route is outside the ${slot} slot`);
      if (
        registered.some(
          (earlier) =>
            earlier.method === item.method &&
            routesOverlap(earlier.segments, item.segments),
        )
      ) {
        throw new Error("Operator route already registered");
      }
      registered.push(item);
    }
    this.slots.set(slot, registered);
  }

  private validateRoute(
    route: OperatorRoute,
    slot?: OperatorRouteSlot,
  ): RegisteredRoute {
    if (
      !route ||
      (route.method !== "GET" && route.method !== "POST") ||
      typeof route.handler !== "function"
    ) {
      throw new Error("Invalid operator route");
    }
    const segments = parseRoutePath(route.path, slot);
    const routes = slot ? (this.slots.get(slot) ?? []) : this.routes;
    if (
      routes.some(
        (registered) =>
          registered.method === route.method &&
          routesOverlap(registered.segments, segments),
      )
    ) {
      throw new Error("Operator route already registered");
    }
    return { ...route, segments };
  }

  mount(): void {
    this.started = true;
  }

  match(
    method: string,
    pathname: string,
  ):
    | { handler: OperatorRouteHandler; params: Record<string, string> }
    | undefined {
    return this.matchRoutes(this.routes, method, pathname);
  }

  matchSlot(
    slot: OperatorRouteSlot,
    method: string,
    pathname: string,
  ):
    | { handler: OperatorRouteHandler; params: Record<string, string> }
    | undefined {
    return this.matchRoutes(this.slots.get(slot) ?? [], method, pathname);
  }

  private matchRoutes(
    routes: RegisteredRoute[],
    method: string,
    pathname: string,
  ):
    | { handler: OperatorRouteHandler; params: Record<string, string> }
    | undefined {
    if (method !== "GET" && method !== "POST") return undefined;
    const encodedSegments =
      pathname === "" || pathname === "/" ? [] : pathname.slice(1).split("/");
    const segments = encodedSegments.map(decodeSegment);
    if (segments.some((segment) => segment === undefined)) return undefined;
    const decoded = segments as string[];
    for (const route of routes) {
      if (route.method !== method || route.segments.length !== decoded.length) {
        continue;
      }
      const params: Record<string, string> = {};
      let matches = true;
      for (let index = 0; index < decoded.length; index += 1) {
        const expected = route.segments[index];
        const actual = decoded[index];
        if (expected?.startsWith(":")) {
          params[expected.slice(1)] = actual ?? "";
        } else if (expected !== actual) {
          matches = false;
          break;
        }
      }
      if (matches) return { handler: route.handler, params };
    }
    return undefined;
  }
}
