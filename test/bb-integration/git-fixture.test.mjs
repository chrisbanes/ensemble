import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixtureGit } from "./harness.mjs";

test("fixture commits ignore inherited Git signing, hooks, and templates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ensemble-git-fixture-"));
  try {
    const hostileHooks = path.join(root, "hostile-hooks");
    const hostileTemplates = path.join(root, "hostile-templates");
    await Promise.all(
      [hostileHooks, hostileTemplates].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    const hook = path.join(hostileHooks, "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 83\n");
    await chmod(hook, 0o755);
    const globalConfig = path.join(root, "hostile.gitconfig");
    await writeFile(
      globalConfig,
      `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hostileHooks}\n[init]\n\ttemplateDir = ${hostileTemplates}\n`,
    );
    const instance = {
      root,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_TEMPLATE_DIR: hostileTemplates,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "true",
      },
    };
    const project = path.join(root, "project");
    await fixtureGit(instance, ["init", "-b", "main", project]);
    await writeFile(path.join(project, "README.md"), "Fixture\n");
    await fixtureGit(instance, ["-C", project, "add", "README.md"]);
    await fixtureGit(instance, [
      "-C",
      project,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Fixture commit",
    ]);
    const { stdout } = await fixtureGit(instance, [
      "-C",
      project,
      "log",
      "-1",
      "--format=%s",
    ]);
    assert.equal(stdout.trim(), "Fixture commit");
    assert.match(
      await readFile(path.join(project, "README.md"), "utf8"),
      /Fixture/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
