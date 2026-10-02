import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createOperatorFixture,
  seedOperatorDelivery,
} from "./fixtures/operator-web.js";
import { actionKinds } from "../src/core/delivery.js";
import { runtimeOperatorRoutes } from "../src/standalone/operator-runtime.js";
import { coordinationOperatorRoutes } from "../src/standalone/operator-coordination.js";
test("retained rendered form actions, fields and mounted route controls match documented owners", async (t) => {
  let providerCalls = 0;
  const unexpectedProviderCall = async () => {
    providerCalls++;
    throw Error("Unexpected fixture provider call");
  };
  const f = await createOperatorFixture(null, undefined, {
    providerFactory: () => ({
      inspectAction: unexpectedProviderCall,
      preflight: unexpectedProviderCall,
      performAction: unexpectedProviderCall,
      inspectPr: unexpectedProviderCall,
    }),
  });
  t.after(() => f.close());
  const d = f.service.domain();
  const projectId = randomUUID(),
    profileId = randomUUID(),
    taskId = randomUUID(),
    blockerId = randomUUID(),
    assignmentId = randomUUID();
  const command = (body: Record<string, unknown>) =>
    d.execute({ actor: "operator", key: randomUUID(), ...body } as never);
  command({
    type: "profile.create",
    profileId,
    name: "Lead",
    instructions: "Private",
    capabilities: "coordinate",
  });
  command({
    type: "project.create",
    projectId,
    name: "Project",
    leadProfileId: profileId,
  });
  for (const [id, title] of [
    [taskId, "Task"],
    [blockerId, "Blocker"],
  ])
    command({
      type: "task.create",
      projectId,
      taskId: id,
      title,
      outcome: "Finish",
      ready: false,
    });
  command({
    type: "assignment.create",
    projectId,
    taskId,
    assignmentId,
    profileId,
    brief: "Work",
    resultDestination: "lead",
    requesterAssignmentId: null,
  });
  command({
    type: "dependency.add",
    projectId,
    taskId,
    blockerTaskId: blockerId,
    expectedVersion: 1,
  });
  command({
    type: "project.configure",
    projectId,
    expectedVersion: 1,
    instructions: "Changed instructions",
  });
  command({
    type: "github.configure",
    projectId,
    expectedVersion: 1,
    credentialRef: null,
    selections: [
      {
        id: "repo",
        kind: "repository",
        repositoryId: "R1",
        owner: "owner",
        name: "repo",
      },
    ],
    readiness: { mode: "all", conditions: [{ kind: "label", name: "ready" }] },
    repositories: [],
  });
  const importedId = randomUUID();
  command({
    type: "task.create",
    projectId,
    taskId: importedId,
    title: "Imported",
    outcome: "Provider outcome",
    ready: false,
  });
  d.markImportedTask(importedId, "I1", "R1");
  const otherProject = randomUUID();
  command({
    type: "project.create",
    projectId: otherProject,
    name: "Other",
    leadProfileId: null,
  });
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO github_external_issues VALUES ('github.com','I1',?,'R1','owner/repo',1,'Imported','Body','open','[]')",
    ).run(importedId);
    db.prepare(
      "INSERT INTO github_memberships VALUES (?,'repo','I1','[]')",
    ).run(projectId);
    db.prepare(
      "INSERT INTO github_memberships VALUES (?,'repo','I1','[]')",
    ).run(otherProject);
    db.prepare("INSERT INTO github_source_reviews VALUES (?,?,?,?,NULL)").run(
      "I1",
      "a".repeat(64),
      "b".repeat(64),
      "accept-revised-scope",
    );
    db.prepare(
      "INSERT INTO github_source_holds VALUES ('I1',1,'source hold',1)",
    ).run();
  });
  const workId = "inventory-work",
    resultId = randomUUID();
  f.seedPersistedState((db) => {
    db.prepare(
      "INSERT INTO execution_intents(id,workId,prompt,workspace,state,reason,threadId,turnId,accountType,sandbox,approval) VALUES (?,?,'fixture','fixture','completed',NULL,'fixture-thread','fixture-turn','chatgpt','workspaceWrite','never')",
    ).run(randomUUID(), workId);
    db.prepare(
      "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,action,target,materialHash,materialJson,revision) VALUES (?,?,?,?,1,1,1,'question','open','Choose target',NULL,NULL,NULL,NULL,1)",
    ).run(randomUUID(), taskId, assignmentId, workId);
    for (const material of ['{"version":"next"}', null])
      db.prepare(
        "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,action,target,materialHash,materialJson,revision) VALUES (?,?,?,?,1,1,1,'approval','open','Publish','Publish','next',?,?,1)",
      ).run(
        randomUUID(),
        taskId,
        assignmentId,
        workId,
        "a".repeat(64),
        material,
      );
    db.prepare(
      "INSERT INTO coordination_results(resultId,taskId,assignmentId,workId,workRevision,assignmentVersion,summary,payloadHash,recipientAssignmentId,destinationDisposition) VALUES (?,?,?,?,1,1,'Retained result',?,NULL,'unresolved')",
    ).run(resultId, taskId, assignmentId, workId, "a".repeat(64));
    db.prepare(
      "INSERT INTO coordination_unresolved_result_destinations(resultId,taskId,assignmentId,originalDestination,reason,revision,status) VALUES (?,?,?,'lead','Unresolved',1,'unresolved')",
    ).run(resultId, taskId, assignmentId);
  });
  command({
    type: "delivery.configure",
    projectId,
    expectedVersion: 1,
    mode: "reviewable-pr",
    credentialRef: null,
    grants: actionKinds.map((action) => ({
      action,
      repositoryId: "R1",
      mode: "approval",
      ...(action === "project.field"
        ? { projectNodeId: "P1", fieldNodeId: "F1", optionNodeIds: ["O1"] }
        : {}),
    })),
    requiredChecks: [{ name: "check", appId: 42 }],
  });
  const deliveryCaller = seedOperatorDelivery(f, {
    projectId,
    taskId,
    assignmentId,
  });
  const web = await f.startWeb();
  let response = await fetch(`${web.origin}/api/operator/session`);
  let cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const session = (await response.json()) as { csrfToken: string };
  response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie,
      origin: web.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: web.password }),
  });
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const routes = runtimeOperatorRoutes(f.service).concat(
    coordinationOperatorRoutes(f.service.coordinationView(), d, (id) =>
      f.service.routingAvailability(id),
    ),
  );
  const inventory = await readFile(
    new URL("../../docs/design/ui02-foundation.md", import.meta.url),
    "utf8",
  );
  const dispositions = await readFile(
    new URL("../../docs/design/ui06-configuration.md", import.meta.url),
    "utf8",
  );
  const dispositionRows = dispositions
    .split("\n")
    .filter((line) => line.startsWith("| "))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  let individual = 0;
  const resolve = (path: string) =>
    path.replace(
      ":id",
      path.includes("profiles") || path.startsWith("/profile/")
        ? profileId
        : path.includes("assignments") || path.includes("assignment/")
          ? assignmentId
          : path.includes("tasks") || path.includes("task/")
            ? taskId
            : projectId,
    );
  const reached = new Set<string>();
  for (const line of inventory.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (
      cells.length !== 5 ||
      cells[0] === "Existing destination" ||
      cells[0] === "---"
    )
      continue;
    for (const control of (cells[2] ?? "").split(";")) {
      const row = dispositionRows.find(
        (r) => r[0] === cells[1] && r[1] === control.trim(),
      );
      assert.ok(
        row,
        `${cells[1]} ${control.trim()} has an individual disposition`,
      );
      assert.ok((row[4]?.length ?? 0) > 30, "concrete scope disposition");
      const destination = resolve(row[3] ?? "");
      if (!reached.has(destination)) {
        const response = await fetch(`${web.origin}${destination}`, {
          headers: { cookie },
        });
        assert.equal(response.status, 200, destination);
        reached.add(destination);
      }
      individual++;
    }
  }
  console.log(
    `UI06 inventory: ${individual} individual controls; ${reached.size} concrete reachable destinations`,
  );
  for (const route of routes)
    assert.ok(
      inventory.includes(
        route.path.replace(":taskId", ":id").replace(":assignmentId", ":id"),
      ) || inventory.includes(route.path),
      `${route.method} ${route.path} has retained owner`,
    );
  const paths = [
    "/",
    `/project/${projectId}`,
    `/task/${taskId}`,
    `/task/${importedId}`,
    `/profile/${profileId}`,
    `/assignment/${assignmentId}`,
    "/runtime",
    `/runtime/task/${taskId}`,
    `/runtime/assignment/${assignmentId}`,
    "/coordination",
    `/coordination/task/${taskId}`,
    `/coordination/assignment/${assignmentId}`,
  ];
  const actions = new Set<string>(),
    commands = new Set<string>(),
    fields = new Set<string>(),
    destinations = new Set<string>();
  let forms = 0;
  for (const path of paths) {
    const r = await fetch(`${web.origin}${path}`, { headers: { cookie } });
    assert.equal(r.status, 200, path);
    const html = await r.text();
    for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>/g)) {
      forms++;
      actions.add(match[1] ?? "");
    }
    for (const match of html.matchAll(/data-command="([^"]+)"/g))
      commands.add(match[1] ?? "");
    for (const match of html.matchAll(
      /<(?:input|textarea|select)\b[^>]*name="([^"]+)"/g,
    ))
      fields.add(match[1] ?? "");
    for (const match of html.matchAll(/href="([^"]+)"/g))
      destinations.add(match[1] ?? "");
  }
  for (const c of [
    "project.create",
    "profile.create",
    "task.create",
    "project.configure",
    "delivery.configure",
    "routing.configure",
    "github.configure",
    "github.preview",
    "github.refresh",
    "github.place",
    "source.review",
    "task.configure",
    "profile.configure",
  ]) {
    assert.ok(commands.has(c), `${c} remains rendered`);
    assert.ok(inventory.includes(c), `${c} retains documented owner`);
  }
  for (const path of actions)
    assert.ok(
      path === "/command" || inventory.includes(path),
      `${path} retains owner`,
    );
  for (const name of [
    "name",
    "leadProfileId",
    "instructions",
    "paused",
    "guidance",
    "candidateProfileIds",
    "credentialRef",
    "clearCredentialRef",
    "mode",
    "grants",
    "requiredChecks",
    "expectedDeliveryRevision",
    "expectedPolicyVersion",
    "expectedPrNodeId",
    "expectedHeadSha",
    "selections",
    "readiness",
    "repositories",
    "revoked",
    "capabilities",
    "title",
    "outcome",
    "ready",
    "globalLimit",
    "projectLimit",
    "blockerTaskId",
    "decision",
  ])
    assert.ok(fields.has(name), `${name} remains rendered`);
  for (const path of [
    "/",
    `/project/${projectId}`,
    `/task/${taskId}`,
    `/profile/${profileId}`,
    "/runtime",
    "/coordination",
    "/app",
  ])
    assert.ok(destinations.has(path), `${path} cross-navigation retained`);
  for (const action of [
    "/coordination/control/delivery/settle",
    "/coordination/control/delivery/refresh",
    "/coordination/control/question/answer",
    "/coordination/control/approval/decision",
    "/coordination/control/result/recipient",
  ])
    assert.ok(actions.has(action), `${action} conditional form retained`);
  assert.ok(fields.has("materialJson"));
  assert.ok(forms >= 20);
  const deliveryHtml = await (
    await fetch(`${web.origin}/coordination/task/${taskId}`, {
      headers: { cookie },
    })
  ).text();
  const settlements = [
    ...deliveryHtml.matchAll(
      /<form\b[^>]*action="\/coordination\/control\/delivery\/settle"[^>]*>([\s\S]*?)<\/form>/g,
    ),
  ];
  assert.equal(
    settlements.length,
    2,
    "both bound-PR settlement decisions are present",
  );
  for (const [index, decision] of ["accepted", "closed"].entries()) {
    const material = Object.fromEntries(
      [
        ...String(settlements[index]?.[1]).matchAll(
          /<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g,
        ),
      ].map((m) => [m[1], m[2]]),
    );
    assert.equal(material.taskId, taskId);
    assert.equal(
      material.expectedTaskVersion,
      String(deliveryCaller.taskVersion),
    );
    assert.equal(material.expectedDeliveryRevision, "1");
    assert.equal(material.expectedPolicyVersion, "2");
    assert.equal(material.repositoryId, "R1");
    assert.equal(material.prNumber, "7");
    assert.equal(material.expectedPrNodeId, "P7");
    assert.equal(material.expectedHeadSha, "1".repeat(40));
    assert.equal(material.decision, decision);
  }
  assert.equal(
    f.service.delivery().delivery(taskId)?.registeredWorkId,
    deliveryCaller.workId,
  );
  assert.equal(
    f.service.domain().task(taskId).version,
    deliveryCaller.taskVersion,
  );
  assert.equal(f.runtime.turns, 0);
  assert.equal(providerCalls, 0);
  console.log(
    `UI02 retained inventory: ${forms} rendered forms; ${commands.size} command discriminants; ${actions.size} form actions; ${routes.length} extension routes`,
  );
});
