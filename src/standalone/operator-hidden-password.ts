import { emitKeypressEvents } from "node:readline";

export function readHiddenPassword(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  prompt = "Ensemble operator password: ",
): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) {
    return Promise.reject(new Error("An interactive terminal is required"));
  }

  const wasRaw = input.isRaw;
  return new Promise((resolve, reject) => {
    let password = "";
    let finished = false;
    const finish = (cause?: Error) => {
      if (finished) return;
      finished = true;
      let error = cause;
      const cleanup = (action: () => void) => {
        try {
          action();
        } catch {
          error ??= new Error("Operator password input failed");
        }
      };
      cleanup(() => input.off("keypress", onKeypress));
      cleanup(() => input.off("close", onClose));
      cleanup(() => input.off("error", onError));
      cleanup(() => input.setRawMode(Boolean(wasRaw)));
      cleanup(() => input.pause());
      cleanup(() => output.write("\n"));
      if (error) reject(error);
      else resolve(password);
    };
    const onKeypress = (
      text: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("Operator authentication initialization cancelled"));
      } else if (key.name === "return" || key.name === "enter") {
        finish();
      } else if (key.name === "backspace") {
        password = Array.from(password).slice(0, -1).join("");
      } else if (text && !key.ctrl && !key.meta) {
        password += text;
      }
    };
    const onClose = () => finish(new Error("Operator password input closed"));
    const onError = () => finish(new Error("Operator password input failed"));

    try {
      emitKeypressEvents(input);
      input.on("keypress", onKeypress);
      input.once("close", onClose);
      input.once("error", onError);
      input.setRawMode(true);
      output.write(prompt);
      input.resume();
    } catch {
      finish(new Error("Operator password input failed"));
    }
  });
}
