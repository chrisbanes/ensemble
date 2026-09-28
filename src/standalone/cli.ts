import { StandaloneService } from "./service.js";

const [command, dataDir, ...args] = process.argv.slice(2);
if (!command || !dataDir)
  throw new Error(
    "Usage: ensemble <serve|run|list> ABSOLUTE_DATA_DIR [workId prompt workspace previousWorkId]",
  );
const service = new StandaloneService(dataDir);
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
  } else throw new Error(`Unknown command ${command}`);
} finally {
  await service.stop();
}
