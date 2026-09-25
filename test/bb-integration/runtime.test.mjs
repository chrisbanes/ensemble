import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  bbCli,
  captureOwnedProcesses,
  launchChromium,
  restartBb,
  rpc,
  waitFor,
  withFixture,
} from "./harness.mjs";

const exec = promisify(execFile);
const fixturePluginId = "ensemble-t1-fixture";

function record(instance, name, detail = "passed") {
  instance.runtimeManifest.checks[name] = detail;
}

test("the isolated BB fixture renders, runs a tool, and persists across reloads", async () => {
  await withFixture(async (instance) => {
    const installed = await bbCli(
      instance,
      "plugin",
      "install",
      `path:${instance.fixtureDirectory}`,
      "--yes",
    );
    assert.equal(installed.plugin.id, fixturePluginId);
    assert.equal(installed.plugin.status, "running");
    record(instance, "publicPluginLoader");
    const pluginList = await bbCli(instance, "plugin", "list");
    const plugin = pluginList.plugins.find(
      (entry) => entry.id === fixturePluginId,
    );
    assert.equal(plugin.status, "running");
    assert.equal(plugin.hasSettings, true);

    await bbCli(
      instance,
      "plugin",
      "config",
      fixturePluginId,
      "set",
      "fixture_mode",
      "configured",
    );
    assert.deepEqual((await rpc(instance, "snapshot")).settings, {
      fixture_mode: "configured",
    });
    record(instance, "pluginSettings");

    const browser = await launchChromium(instance);
    const page = await browser.newPage();
    await page.goto(
      `${instance.baseUrl}/plugins/${fixturePluginId}/capability`,
      { waitUntil: "domcontentloaded" },
    );
    await page.getByText("Capability fixture active").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    record(instance, "browserPanel");

    const machine = (await bbCli(instance, "machine", "list")).find(
      (candidate) => candidate.status === "connected",
    );
    assert(machine, "The isolated BB host is not connected");
    const projectRoot = path.join(instance.root, "git-project");
    await mkdir(projectRoot);
    await writeFile(
      path.join(projectRoot, "README.md"),
      "T1 disposable project\n",
    );
    await exec("git", ["init", "-b", "main", projectRoot]);
    await exec("git", [
      "-C",
      projectRoot,
      "-c",
      "user.name=T1 Fixture",
      "-c",
      "user.email=t1-fixture@example.invalid",
      "add",
      "README.md",
    ]);
    await exec("git", [
      "-C",
      projectRoot,
      "-c",
      "user.name=T1 Fixture",
      "-c",
      "user.email=t1-fixture@example.invalid",
      "commit",
      "-m",
      "T1 disposable project",
    ]);

    const project = await bbCli(
      instance,
      "project",
      "create",
      "--name",
      "T1 disposable project",
      "--root",
      projectRoot,
      "--machine",
      machine.id,
    );
    assert.equal(typeof project.id, "string");
    record(instance, "temporaryGitProject", { id: project.id });
    const spawned = await rpc(instance, "spawn", {
      projectId: project.id,
      hostId: machine.id,
    });
    assert.equal(typeof spawned.id, "string");
    const threadId = spawned.id;

    const completed = await waitFor(async () => {
      const snapshot = await rpc(instance, "snapshot");
      const thread = await rpc(instance, "thread", { threadId });
      return snapshot.state.toolCalls === 1 &&
        thread.status === "idle" &&
        snapshot.events.some((event) => event.name === "idle")
        ? { snapshot, thread }
        : false;
    }, "scripted provider tool result and idle thread");
    assert.equal(completed.thread.providerId, "ensemble-scripted");
    assert.equal(completed.thread.projectId, project.id);
    assert.equal(typeof completed.thread.environmentId, "string");
    assert.equal(completed.snapshot.state.migrationVersion, 1);
    assert.equal(completed.snapshot.state.migrationRuns, 1);
    assert.equal(completed.snapshot.state.toolCalls, 1);
    assert.equal(completed.snapshot.state.serverLoads, 1);
    assert(completed.snapshot.events.some((event) => event.name === "created"));
    assert(completed.snapshot.events.some((event) => event.name === "active"));
    assert(completed.snapshot.events.some((event) => event.name === "idle"));

    const providerRequests = (
      await readFile(instance.env.SCRIPTED_ECHO_RECORD_PATH, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const toolResults = providerRequests.filter(
      (entry) => entry.method === "t1/tool-result",
    );
    assert.equal(toolResults.length, 1);
    const [toolResult] = toolResults;
    assert(
      toolResult,
      "The scripted provider did not record the tool response",
    );
    assert.equal(toolResult.params.toolName, "capability_ping");
    assert.equal(toolResult.params.error, null);
    assert.equal(toolResult.params.result.success, true);
    assert(
      toolResult.params.result.contentItems.some(
        (item) =>
          item.type === "inputText" && item.text === "capability result 1",
      ),
      "The scripted provider did not receive the returned SQLite counter value",
    );
    const ownedProcesses = await captureOwnedProcesses(instance);
    const ownedProcessRoles = [
      ...new Set(ownedProcesses.map((owned) => owned.role)),
    ].sort();
    assert(ownedProcessRoles.includes("bb-server"));
    assert(ownedProcessRoles.includes("bb-host-daemon"));
    assert(ownedProcessRoles.includes("scripted-provider"));
    assert(ownedProcessRoles.includes("chromium"));
    record(instance, "ownedProcessRoles", ownedProcessRoles);
    record(instance, "scriptedToolResult", {
      providerId: completed.thread.providerId,
      environmentId: completed.thread.environmentId,
      toolCalls: completed.snapshot.state.toolCalls,
      returnedText: "capability result 1",
      lifecycleEvents: completed.snapshot.events.map((event) => event.name),
    });

    await bbCli(instance, "plugin", "reload", fixturePluginId);
    const afterReload = await waitFor(async () => {
      const snapshot = await rpc(instance, "snapshot");
      return snapshot.state.serverLoads === 2 ? snapshot : false;
    }, "plugin reload completion");
    assert.equal(afterReload.state.migrationVersion, 1);
    assert.equal(afterReload.state.migrationRuns, 1);
    assert.equal(afterReload.state.toolCalls, 1);
    record(instance, "pluginReloadPersistence", {
      migrationRuns: afterReload.state.migrationRuns,
      toolCalls: afterReload.state.toolCalls,
    });

    await restartBb(instance);
    const afterRestart = await waitFor(async () => {
      const snapshot = await rpc(instance, "snapshot");
      return snapshot.state.serverLoads === 3 ? snapshot : false;
    }, "BB restart and fixture reload");
    assert.equal(afterRestart.state.migrationVersion, 1);
    assert.equal(afterRestart.state.migrationRuns, 1);
    assert.equal(afterRestart.state.toolCalls, 1);
    assert.deepEqual(afterRestart.settings, { fixture_mode: "configured" });
    record(instance, "bbRestartPersistence", {
      migrationVersion: afterRestart.state.migrationVersion,
      migrationRuns: afterRestart.state.migrationRuns,
      toolCalls: afterRestart.state.toolCalls,
      serverLoads: afterRestart.state.serverLoads,
    });

    const reloadedBrowser = await launchChromium(instance);
    const reloadedPage = await reloadedBrowser.newPage();
    await reloadedPage.goto(
      `${instance.baseUrl}/plugins/${fixturePluginId}/capability`,
      { waitUntil: "domcontentloaded" },
    );
    await reloadedPage.getByText("Capability fixture active").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    record(instance, "browserPanelAfterRestart");
  });
});
