import { fileURLToPath, pathToFileURL } from "node:url";
import { diagnosticLimitsFromEnv } from "./execution-diagnostics.js";
import { ROOT_REFUSAL } from "./launchd.js";
import { OperatorApi } from "./operator-api.js";
import { OperatorWebBundle, OperatorWebBoundary } from "./operator-web.js";
import { serviceReadiness } from "./readiness.js";
import {
  StandaloneService,
  type BackgroundFailureDiagnostic,
} from "./service.js";
import { LocalOperatorHttp, LocalOperatorUi } from "./operator.js";
import { OperatorAuth } from "./operator-auth.js";
import { OperatorPush } from "./operator-push.js";
import { dirname, join } from "node:path";
import { coordinationOperatorRoutes } from "./operator-coordination.js";
import { OperatorRouteRegistry } from "./operator-routes.js";
import { runtimeOperatorRoutes } from "./operator-runtime.js";

export type ServiceExitReason = "signal" | "background-failure";

/** Wait for one operator signal or this exact service generation's fatal signal. */
export async function waitForServiceExit(
  service: Pick<
    StandaloneService,
    "waitForBackgroundFailure" | "waitForBackgroundShutdown"
  >,
  failureNotification?: Promise<BackgroundFailureDiagnostic>,
): Promise<ServiceExitReason> {
  const notification =
    failureNotification ?? service.waitForBackgroundFailure();
  const reason = await new Promise<ServiceExitReason>((resolve) => {
    let settled = false;
    const cleanup = () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const finish = (value: ServiceExitReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onSignal = () => finish("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    void notification.then(() => finish("background-failure"));
  });
  if (reason === "background-failure") {
    process.exitCode = 1;
    try {
      await service.waitForBackgroundShutdown(notification);
    } catch {
      // The service emitted its fixed safe-shutdown diagnostic; do not expose its error.
    }
  }
  return reason;
}

/** Both harnesses run in production; profiles still default to Codex (ADR-1008, #827). */
export const productionRuntimeHarnesses = ["codex", "claude"] as const;

export const productionService = (dataDir: string) =>
  // Invalid retention variables fail startup rather than using defaults.
  new StandaloneService(dataDir, undefined, undefined, {
    diagnostics: { limits: diagnosticLimitsFromEnv(process.env) },
    runtimeHarnesses: productionRuntimeHarnesses,
  });

export async function main(
  commandLine = process.argv.slice(2),
  serviceFactory: (dataDir: string) => StandaloneService = productionService,
): Promise<void> {
  const [command, dataDir, ...args] = commandLine;
  if (!command || !dataDir)
    throw new Error(
      "Usage: ensemble <serve|operator|run|list> ABSOLUTE_DATA_DIR [workId prompt workspace previousWorkId]",
    );
  const service = serviceFactory(dataDir);
  const operatorAuth =
    command === "operator"
      ? await OperatorAuth.open({
          authFile: process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
          origin: process.env.ENSEMBLE_OPERATOR_ORIGIN ?? "",
        })
      : undefined;
  let fatalBackgroundFailure = false;
  let failureNotification: Promise<BackgroundFailureDiagnostic> | undefined;
  const joinFatalBackgroundFailure = async (
    notification: Promise<BackgroundFailureDiagnostic>,
  ) => {
    fatalBackgroundFailure = true;
    process.exitCode = 1;
    try {
      await service.waitForBackgroundShutdown(notification);
    } catch {
      // The service emitted its fixed safe-shutdown diagnostic; do not expose its error.
    }
  };
  try {
    await service.start();
    failureNotification = service.waitForBackgroundFailure();
    if (
      command === "operator" &&
      service.backgroundFailureObserved(failureNotification)
    ) {
      await joinFatalBackgroundFailure(failureNotification);
      return;
    }
    if (command === "run") {
      const [workId, prompt, workspace, previousWorkId] = args;
      if (!workId || !prompt || !workspace)
        throw new Error("run requires workId, prompt and workspace");
      const result = await service.submit(
        workId,
        prompt,
        workspace,
        previousWorkId,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.state !== "completed") process.exitCode = 1;
    } else if (command === "list") {
      process.stdout.write(`${JSON.stringify(service.list())}\n`);
    } else if (command === "serve") {
      fatalBackgroundFailure =
        (await waitForServiceExit(service, failureNotification)) ===
        "background-failure";
    } else if (command === "operator") {
      if (!operatorAuth)
        throw new Error("Operator authentication is unavailable");
      const routes = new OperatorRouteRegistry();
      routes.registerSlot("runtime", runtimeOperatorRoutes(service));
      routes.registerSlot(
        "coordination",
        coordinationOperatorRoutes(
          service.coordinationView(),
          service.domain(),
          (projectId) => service.routingAvailability(projectId),
        ),
      );
      const bundle = await OperatorWebBundle.open(
        fileURLToPath(new URL("../../operator", import.meta.url)),
      );
      if (service.backgroundFailureObserved(failureNotification)) {
        await joinFatalBackgroundFailure(failureNotification);
        return;
      }
      const authFile = process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "";
      const api = new OperatorApi(service, [dataDir, authFile]);
      const readiness = serviceReadiness(service, api, { dataDir, authFile });
      // The VAPID key sits beside the operator auth file; an unusable one only turns push off.
      const push = await OperatorPush.open({
        store: service.operatorPush(),
        keyFile: join(dirname(authFile), "operator-push-vapid.json"),
        readInbox: (query) => api.readInbox(query),
      });
      const ui = new LocalOperatorHttp(
        new LocalOperatorUi(
          service.domain(),
          (reference) => service.gitHubSourceReader(reference),
          service.githubSources(),
          () => service.refreshGitHub(),
          (projectId) => service.gitHubSourceCredentialStatus(projectId),
        ),
        operatorAuth,
        {
          routes,
          credentials: service.operatorCredentials(),
          push,
          web: new OperatorWebBoundary(bundle, api, readiness),
        },
      );
      await ui.start(args[0] ? Number(args[0]) : 8787);
      process.stdout.write(`${operatorAuth.origin}/app\n`);
      try {
        fatalBackgroundFailure =
          (await waitForServiceExit(service, failureNotification)) ===
          "background-failure";
      } finally {
        try {
          await ui.stop();
        } catch {
          process.exitCode = 1;
          try {
            process.stderr.write(
              "Ensemble operator listener shutdown failed\n",
            );
          } catch {
            // Listener teardown is best-effort after the service has failed.
          }
        }
      }
    } else throw new Error(`Unknown command ${command}`);
  } finally {
    try {
      if (!fatalBackgroundFailure) await service.stop();
    } catch {
      process.exitCode = 1;
      try {
        process.stderr.write("Ensemble service shutdown failed\n");
      } catch {
        // The process still exits unsuccessfully when stderr is unavailable.
      }
    } finally {
      if (failureNotification) {
        try {
          await service.waitForBackgroundShutdown(failureNotification);
        } catch {
          process.exitCode = 1;
        }
        if (service.backgroundFailureObserved(failureNotification))
          process.exitCode = 1;
      }
      operatorAuth?.close();
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  // The service's own entry point, as launchd starts it, never runs as root.
  // A fixed message on stderr, not a stack trace, in the launchd log.
  if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
    process.stderr.write(`${ROOT_REFUSAL}\n`);
    process.exit(1);
  }
  await main();
}
