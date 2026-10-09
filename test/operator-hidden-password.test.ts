import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { readHiddenPassword } from "../src/standalone/operator-hidden-password.js";

function ttyInput() {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(raw: boolean): NodeJS.ReadStream;
  };
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = (raw) => {
    stream.isRaw = raw;
    return stream as unknown as NodeJS.ReadStream;
  };
  return stream as unknown as NodeJS.ReadStream &
    PassThrough & {
      isRaw: boolean;
    };
}

function output() {
  const chunks: string[] = [];
  return {
    stream: {
      isTTY: true,
      write(value: string) {
        chunks.push(value);
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    text: () => chunks.join(""),
  };
}

test("hidden password reader restores and pauses the terminal after success", async () => {
  const input = ttyInput();
  const terminal = output();
  const result = readHiddenPassword(
    input,
    terminal.stream,
    "Fixture password: ",
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("private-passphrase\n");

  assert.equal(await result, "private-passphrase");
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.equal(terminal.text(), "Fixture password: \n");
  input.destroy();
});

test("hidden password reader restores and pauses after input error or close", async (t) => {
  for (const ending of ["error", "close"] as const) {
    await t.test(ending, async () => {
      const input = ttyInput();
      const terminal = output();
      const pause = input.pause.bind(input);
      let pauseCalls = 0;
      input.pause = () => {
        pauseCalls += 1;
        return pause();
      };
      const result = readHiddenPassword(input, terminal.stream, "Password: ");
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (ending === "error")
        input.emit("error", new Error("secret input detail"));
      else input.destroy();

      await assert.rejects(result, /input (?:failed|closed)/i);
      assert.equal(input.isRaw, false);
      assert.ok(pauseCalls > 0, "pause was requested");
      // A destroyed stream ignores pause() on newer Node releases.
      if (ending === "error") assert.equal(input.isPaused(), true);
      assert.doesNotMatch(terminal.text(), /secret input detail/);
    });
  }
});

test("operator auth CLI exits safely when hidden input is not a terminal", () => {
  const directory = mkdtempSync(join(tmpdir(), "ensemble-operator-auth-cli-"));
  try {
    const authFile = join(directory, "operator-auth.json");
    const sentinel = "never-print-this-password";
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "dist/src/standalone/operator-auth-cli.js"),
        "init",
        authFile,
      ],
      { input: `${sentinel}\n`, encoding: "utf8", timeout: 2_000 },
    );
    assert.equal(result.status, 1);
    assert.equal(result.error, undefined);
    assert.match(result.stderr, /initialization failed/i);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      new RegExp(sentinel),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
