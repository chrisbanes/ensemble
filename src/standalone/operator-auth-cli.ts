import { isAbsolute } from "node:path";
import { OperatorAuth } from "./operator-auth.js";
import { readHiddenPassword } from "./operator-hidden-password.js";

const [command, authFile, ...extra] = process.argv.slice(2);
if (
  command !== "init" ||
  !authFile ||
  extra.length > 0 ||
  !isAbsolute(authFile)
) {
  process.stderr.write(
    "Usage: npm run operator-auth -- init ABSOLUTE_AUTH_FILE\n",
  );
  process.exitCode = 2;
} else {
  try {
    const password = await readHiddenPassword();
    await OperatorAuth.initialize(authFile, password);
    process.stdout.write("Operator authentication initialized\n");
  } catch {
    process.stderr.write("Operator authentication initialization failed\n");
    process.exitCode = 1;
  }
}
