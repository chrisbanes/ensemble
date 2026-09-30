import { StandaloneService } from "./service.js";
import { LocalOperatorHttp, LocalOperatorUi } from "./operator.js";
import { OperatorAuth } from "./operator-auth.js";
import { coordinationOperatorRoutes } from "./operator-coordination.js";
import { OperatorRouteRegistry } from "./operator-routes.js";
import { runtimeOperatorRoutes } from "./operator-runtime.js";

const [command, dataDir, ...args] = process.argv.slice(2);
if (!command || !dataDir)
  throw new Error(
    "Usage: ensemble <serve|operator|run|list> ABSOLUTE_DATA_DIR [workId prompt workspace previousWorkId]",
  );
const service = new StandaloneService(dataDir);
const operatorAuth =
  command === "operator"
    ? await OperatorAuth.open({
        authFile: process.env.ENSEMBLE_OPERATOR_AUTH_FILE ?? "",
        origin: process.env.ENSEMBLE_OPERATOR_ORIGIN ?? "",
      })
    : undefined;
await service.start();
try {
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
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
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
    const ui = new LocalOperatorHttp(
      new LocalOperatorUi(service.domain()),
      operatorAuth,
      { routes },
    );
    await ui.start(args[0] ? Number(args[0]) : 8787);
    process.stdout.write(`${operatorAuth?.origin}/\n`);
    try {
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    } finally {
      await ui.stop();
    }
  } else throw new Error(`Unknown command ${command}`);
} finally {
  await service.stop();
  operatorAuth?.close();
}
