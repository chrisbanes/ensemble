import { z } from "zod";
import {
  sourceObservationSchema,
  apiErrorSchema,
  commandReceiptSchema,
  operatorCommandSchema,
  sessionSchema,
  type CommandReceipt,
  type OperatorCommand,
} from "../../src/operator/contracts.js";
export class ClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly fieldPaths: readonly string[] = [],
  ) {
    super(code);
  }
}
export type CommandState =
  | { state: "recorded"; receipt: CommandReceipt }
  | {
      state: "conflict" | "rejected" | "unknown";
      command: OperatorCommand;
      code: string;
      fieldPaths?: readonly string[];
    };
export class OperatorClient {
  private authenticationGeneration = 0;
  invalidateAuthentication() {
    this.authenticationGeneration++;
  }
  captureAuthenticationScope() {
    const generation = this.authenticationGeneration;
    return () => generation === this.authenticationGeneration;
  }
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly expired: () => void = () => {},
  ) {}
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    if (!path.startsWith("/api/operator/") || path.includes("://"))
      throw new ClientError("invalid-input", 400);
    const isCurrentAuthentication = this.captureAuthenticationScope();
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await fetcher(path, {
        ...init,
        credentials: "same-origin",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ClientError(
        init.method === "POST" ? "command-outcome-unknown" : "unavailable",
        503,
      );
    }
    if (response.status === 401) {
      if (path !== "/api/operator/login" && isCurrentAuthentication())
        this.expired();
      throw new ClientError("unauthenticated", 401);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ClientError(
        init.method === "POST" ? "command-outcome-unknown" : "unavailable",
        503,
      );
    }
    if (!response.ok) {
      const error = apiErrorSchema.safeParse(body);
      throw new ClientError(
        error.success
          ? error.data.error.code
          : init.method === "POST"
            ? "command-outcome-unknown"
            : "unavailable",
        response.status,
        error.success ? (error.data.error.fieldPaths ?? []) : [],
      );
    }
    const value = schema.safeParse(body);
    if (!value.success)
      throw new ClientError(
        init.method === "POST" ? "command-outcome-unknown" : "invalid-response",
        503,
      );
    return value.data;
  }
  read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return this.request(path, schema, signal ? { signal } : {});
  }
  session() {
    return this.read("/api/operator/session", sessionSchema);
  }
  login(password: string, csrfToken: string) {
    return this.request("/api/operator/login", sessionSchema, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ password }),
    });
  }
  logout(csrfToken: string) {
    return this.request(
      "/api/operator/logout",
      z.object({ authenticated: z.literal(false) }).strict(),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: "{}",
      },
    );
  }
  refreshSources(csrfToken: string) {
    return this.request(
      "/api/operator/source-refresh",
      sourceObservationSchema,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: "{}",
      },
    );
  }
  async command(
    input: OperatorCommand,
    csrfToken: string,
  ): Promise<CommandState> {
    // Locally invalid input was never sent, so it is a definitive rejection.
    const parsed = operatorCommandSchema.safeParse(input);
    if (!parsed.success)
      return { state: "rejected", command: input, code: "invalid-input" };
    const command = parsed.data;
    try {
      return {
        state: "recorded",
        receipt: await this.request(
          "/api/operator/commands",
          commandReceiptSchema,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrfToken,
            },
            body: JSON.stringify(command),
          },
        ),
      };
    } catch (error) {
      const e =
        error instanceof ClientError
          ? error
          : new ClientError("command-outcome-unknown", 503);
      return {
        state:
          e.status === 409
            ? "conflict"
            : e.code === "command-outcome-unknown"
              ? "unknown"
              : "rejected",
        command,
        code: e.code,
        fieldPaths: e.fieldPaths,
      };
    }
  }
}
