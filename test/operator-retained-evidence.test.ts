import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  RetainedEvidenceStore,
  type RetainedEvidenceCandidate,
  type RetainedEvidenceIdentity,
} from "../src/core/retained-evidence.js";
import { transaction } from "../src/core/store.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { OperatorWebBoundary } from "../src/standalone/operator-web.js";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedReviewTask } from "./fixtures/task-review.js";

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iY9sAAAAASUVORK5CYII=",
  "base64",
);

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for fixture state");
}

async function captureNativeResult(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  options: { withArtifact?: boolean; createArtifact?: boolean } = {},
) {
  const seeded = await seedReviewTask(f, "Retained API", "Read exact evidence");
  const domain = f.service.domain();
  domain.execute({
    type: "project.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    expectedVersion: Number(domain.project(seeded.projectId).version),
    paused: false,
  });
  domain.execute({
    type: "task.configure",
    actor: "operator",
    key: randomUUID(),
    projectId: seeded.projectId,
    taskId: seeded.taskId,
    expectedVersion: Number(domain.task(seeded.taskId).version),
    ready: true,
  });
  await waitFor(() => f.runtime.turns > 0);
  await waitFor(() =>
    f.service.list().some((work) => work.state === "running"),
  );
  const work = f.service.list().find((entry) => entry.state === "running");
  assert.ok(work?.threadId && work.turnId);
  const workspace = await f.service.taskWorkspace(seeded.taskId);
  assert.equal(workspace?.state, "ready");
  if (workspace?.state !== "ready") throw new Error("Workspace missing");
  const textPath = join(workspace.path, "retained-proof.txt");
  const originalText = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("first\r\nsecond\r\nfinal-without-newline", "utf8"),
  ]);
  await writeFile(textPath, originalText);
  const artifactId = randomUUID();
  const artifactPath = join(workspace.path, "retained-proof.png");
  const withArtifact = options.withArtifact ?? false;
  if (withArtifact && options.createArtifact !== false)
    await writeFile(artifactPath, png);
  const call = {
    threadId: work.threadId,
    turnId: work.turnId,
    callId: randomUUID(),
    tool: "ensemble_report_result",
    arguments: {
      summary: "Retain exact callback evidence",
      review: {
        sourceId: seeded.source.sourceId,
        changes: { files: ["retained-proof.txt"] },
        ...(withArtifact
          ? {
              artifacts: [
                {
                  artifactId,
                  label: "Retained screenshot",
                  role: "evidence" as const,
                  revision: 1,
                  availability: "available" as const,
                  file: {
                    relativePath: "retained-proof.png",
                    sha256: digest(png),
                    mime: "image/png" as const,
                    size: png.byteLength,
                  },
                },
              ],
            }
          : {}),
      },
    },
  };
  const response = await f.runtime.callTool(call);
  assert.equal(response.success, true, response.text);
  const recorded = f.service
    .coordinationView()
    .readTask(seeded.taskId)
    .results.find((result) => result.workId === work.workId);
  assert.ok(recorded);
  const manifest = f.service
    .retainedEvidence()
    .result(seeded.taskId, recorded.resultId);
  assert.ok(manifest);
  const textItem = manifest.items.find(
    (item) => item.state === "available" && item.path === "retained-proof.txt",
  );
  assert.ok(textItem?.state === "available");
  const artifactItem = withArtifact
    ? manifest.items.find((item) => item.artifactId === artifactId)
    : undefined;
  f.runtime.complete(f.runtime.turns);
  await waitFor(
    () => !f.service.list().some((entry) => entry.state === "running"),
  );
  return {
    seeded,
    work,
    workspace,
    textPath,
    originalText,
    artifactId: withArtifact ? artifactId : undefined,
    artifactPath: withArtifact ? artifactPath : undefined,
    originalArtifact: withArtifact ? png : undefined,
    resultId: recorded.resultId,
    manifest,
    textItem,
    artifactItem,
  };
}

async function login(web: { origin: string; password: string }) {
  const anonymous = await fetch(`${web.origin}/api/operator/session`);
  const anon = (await anonymous.json()) as { csrfToken: string };
  const response = await fetch(`${web.origin}/api/operator/login`, {
    method: "POST",
    headers: {
      cookie: anonymous.headers.get("set-cookie")!.split(";")[0]!,
      origin: web.origin,
      "content-type": "application/json",
      "x-csrf-token": anon.csrfToken,
    },
    body: JSON.stringify({ password: web.password }),
  });
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrfToken: ((await response.json()) as { csrfToken: string }).csrfToken,
  };
}

function readState(
  f: Awaited<ReturnType<typeof createOperatorFixture>>,
  taskId: string,
) {
  const task = f.service.coordinationView().readTask(taskId);
  return {
    work: f.service.list().map(({ workId, state, threadId, turnId }) => ({
      workId,
      state,
      threadId,
      turnId,
    })),
    hold: f.service.taskHold(taskId) ?? null,
    results: task.results.map((result) => result.resultId),
    receipts: task.results.length,
    turnCaptures: f.service.workspaceTurnCaptureSlots(taskId),
  };
}

test("authenticated retained reads preserve exact bytes through edits, cleanup and restart", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const captured = await captureNativeResult(f, { withArtifact: true });
  assert.ok(captured.artifactItem?.state === "available");
  const renamedPath = join(captured.workspace.path, "rename-proof.txt");
  const conflictedPath = join(captured.workspace.path, "conflict-proof.txt");
  const renamedBytes = Buffer.from("rename original\r\nsecond line\r\n");
  const conflictedBytes = Buffer.from(
    "conflict original\r\nretained lines\r\n",
  );
  await writeFile(renamedPath, renamedBytes);
  await writeFile(conflictedPath, conflictedBytes);
  const anchorStage = await f.service.stageReviewAnchorDraft({
    taskId: captured.seeded.taskId,
    operationId: randomUUID(),
    anchors: [
      {
        taskId: captured.seeded.taskId,
        repositoryId: null,
        path: "retained-proof.txt",
        sourceKind: "workspace-file",
        context: "workspace",
        side: "file",
        startLine: 1,
        endLine: 2,
        contentSha256: digest(captured.originalText),
      },
      {
        taskId: captured.seeded.taskId,
        repositoryId: null,
        path: "rename-proof.txt",
        sourceKind: "workspace-file",
        context: "workspace",
        side: "file",
        startLine: 1,
        endLine: 2,
        contentSha256: digest(renamedBytes),
      },
      {
        taskId: captured.seeded.taskId,
        repositoryId: null,
        path: "conflict-proof.txt",
        sourceKind: "workspace-file",
        context: "workspace",
        side: "file",
        startLine: 1,
        endLine: 2,
        contentSha256: digest(conflictedBytes),
      },
    ],
  });
  const anchorId = anchorStage.anchorIds[0]!;
  const renamedAnchorId = anchorStage.anchorIds[1]!;
  const conflictedAnchorId = anchorStage.anchorIds[2]!;
  const expectedExcerpt = captured.originalText.subarray(
    0,
    Buffer.byteLength("\uFEFFfirst\r\nsecond\r\n", "utf8"),
  );
  await rm(captured.textPath);
  await rename(renamedPath, join(captured.workspace.path, "renamed-proof.txt"));
  await writeFile(captured.artifactPath!, Buffer.from("later image bytes"));

  let web = await f.startWeb();
  t.after(() => web.close());
  const session = await login(web);
  const base =
    web.origin +
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/results/" +
    captured.resultId +
    "/evidence";
  const manifestPath = base.slice(web.origin.length);
  const itemPath = `${manifestPath}/${captured.textItem.itemId}`;
  const artifactPathRoute =
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/artifacts/" +
    captured.artifactId;
  const anchorPathRoute =
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/review-anchors/" +
    anchorId;
  const renamedAnchorPathRoute =
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/review-anchors/" +
    renamedAnchorId;
  const conflictedAnchorPathRoute =
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/review-anchors/" +
    conflictedAnchorId;
  const before = readState(f, captured.seeded.taskId);
  const manifestResponse = await fetch(web.origin + manifestPath, {
    headers: { cookie: session.cookie },
  });
  assert.equal(
    manifestResponse.status,
    200,
    await manifestResponse.clone().text(),
  );
  const manifest = (await manifestResponse.json()) as {
    data: {
      resultId: string;
      state: string;
      items: Array<Record<string, unknown> & { itemId: string; state: string }>;
    };
  };
  assert.equal(manifest.data.resultId, captured.resultId);
  assert.equal(manifest.data.state, "partial");
  assert.ok(
    manifest.data.items.some(
      (item) =>
        item.itemId === captured.textItem.itemId && item.state === "available",
    ),
  );
  const itemResponse = await fetch(web.origin + itemPath, {
    headers: { cookie: session.cookie },
  });
  assert.equal(itemResponse.status, 200);
  const item = (await itemResponse.json()) as {
    data: {
      item: { sha256: string; size: number };
      preview: { kind: "text"; text: string };
    };
  };
  assert.equal(item.data.item.sha256, digest(captured.originalText));
  assert.equal(item.data.item.size, captured.originalText.byteLength);
  assert.deepEqual(
    Buffer.from(item.data.preview.text, "utf8"),
    captured.originalText,
  );

  const artifactResponse = await fetch(web.origin + artifactPathRoute, {
    headers: { cookie: session.cookie },
  });
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await artifactResponse.arrayBuffer()), png);

  for (const [route, expected] of [
    [anchorPathRoute, expectedExcerpt],
    [renamedAnchorPathRoute, renamedBytes],
  ] as const) {
    const anchorResponse = await fetch(web.origin + route, {
      headers: { cookie: session.cookie },
    });
    assert.equal(anchorResponse.status, 200);
    const anchor = (await anchorResponse.json()) as {
      data: {
        state: string;
        status: string;
        anchor: Record<string, unknown>;
        preview: { kind: "text"; text: string };
      };
    };
    assert.equal(anchor.data.state, "available");
    assert.equal(anchor.data.status, "outdated");
    assert.deepEqual(Buffer.from(anchor.data.preview.text, "utf8"), expected);
    assert.equal("originRoot" in anchor.data.anchor, false);
  }
  const originalTaskWorkspace = f.service.taskWorkspace;
  let workspaceReads = 0;
  f.service.taskWorkspace = async (...args) => {
    const binding = await originalTaskWorkspace.call(f.service, ...args);
    workspaceReads++;
    return binding && workspaceReads === 2
      ? { ...binding, workspaceId: randomUUID() }
      : binding;
  };
  try {
    const conflictedAnchorResponse = await fetch(
      web.origin + conflictedAnchorPathRoute,
      { headers: { cookie: session.cookie } },
    );
    assert.equal(conflictedAnchorResponse.status, 200);
    const conflictedAnchor = (await conflictedAnchorResponse.json()) as {
      data: {
        state: string;
        status: string;
        preview: { kind: "text"; text: string };
      };
    };
    assert.equal(conflictedAnchor.data.state, "available");
    assert.equal(conflictedAnchor.data.status, "unknown");
    assert.deepEqual(
      Buffer.from(conflictedAnchor.data.preview.text, "utf8"),
      conflictedBytes,
    );
  } finally {
    f.service.taskWorkspace = originalTaskWorkspace;
  }
  const after = readState(f, captured.seeded.taskId);
  assert.deepEqual(
    after,
    before,
    "GETs do not mutate work, holds, results or latest slots",
  );

  await web.close();
  const archived = await f.service.archiveTask(captured.seeded.taskId, {
    deliveryConfirmed: true,
    writerOwnershipResolved: true,
    handoffsPreserved: true,
    reconciliationEvidencePreserved: true,
    workspaceContentsPreserved: true,
  });
  assert.equal(archived.outcome, "cleaned");
  await f.reopen();
  web = await f.startWeb();
  t.after(() => web.close());
  const reopenedSession = await login(web);
  for (const route of [
    manifestPath,
    itemPath,
    artifactPathRoute,
    anchorPathRoute,
    renamedAnchorPathRoute,
  ]) {
    const response = await fetch(web.origin + route, {
      headers: { cookie: reopenedSession.cookie },
    });
    assert.notEqual(response.status, 401);
    if (route === artifactPathRoute) {
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    } else {
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes(captured.workspace.path), false);
      assert.equal(body.includes(f.directory), false);
    }
  }
  for (const [route, expected] of [
    [anchorPathRoute, expectedExcerpt],
    [renamedAnchorPathRoute, renamedBytes],
  ] as const) {
    const reopenedAnchor = await fetch(web.origin + route, {
      headers: { cookie: reopenedSession.cookie },
    });
    const reopenedAnchorBody = (await reopenedAnchor.json()) as {
      data: { status: string; preview: { kind: "text"; text: string } };
    };
    assert.equal(reopenedAnchorBody.data.status, "unknown");
    assert.deepEqual(
      Buffer.from(reopenedAnchorBody.data.preview.text, "utf8"),
      expected,
    );
  }
});

test("a retained artifact gap stays a gap after a matching live file appears", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const captured = await captureNativeResult(f, {
    withArtifact: true,
    createArtifact: false,
  });
  assert.equal(captured.artifactItem?.state, "gap");
  await writeFile(captured.artifactPath!, png);
  const web = await f.startWeb();
  t.after(() => web.close());
  const session = await login(web);
  const base =
    web.origin +
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/results/" +
    captured.resultId +
    "/evidence";
  const manifest = await fetch(base, { headers: { cookie: session.cookie } });
  assert.equal(manifest.status, 200, await manifest.clone().text());
  const manifestBody = (await manifest.json()) as {
    data: { items: Array<{ itemId: string; state: string; reason?: string }> };
  };
  assert.ok(
    manifestBody.data.items.some(
      (item) =>
        item.itemId === captured.artifactItem!.itemId &&
        item.state === "gap" &&
        item.reason === "missing",
    ),
  );
  const artifactItem = captured.artifactItem!;
  const contentResponse = await fetch(`${base}/${artifactItem.itemId}`, {
    headers: { cookie: session.cookie },
  });
  assert.equal(contentResponse.status, 200);
  const content = (await contentResponse.json()) as {
    data: { state: string; reason?: string; preview?: unknown };
  };
  assert.equal(content.data.state, "gap");
  assert.equal(content.data.reason, "missing");
  assert.equal("preview" in content.data, false);
  const artifactResponse = await fetch(
    web.origin +
      "/api/operator/tasks/" +
      captured.seeded.taskId +
      "/artifacts/" +
      captured.artifactId,
    { headers: { cookie: session.cookie } },
  );
  assert.equal(artifactResponse.status, 503);
  const error = (await artifactResponse.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(error.error.code, "unavailable");
  assert.equal(error.error.message, "Service unavailable. Try again.");
  assert.equal(error.error.message.includes("png"), false);
});

test("current exclusions cover every retained diff and rename path without metadata leaks", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const seeded = await seedReviewTask(f, "Rename privacy", "Hide old path");
  const legacy = seeded.result("Retained exact diff owner", {
    sourceId: seeded.source.sourceId,
  });
  const result = f.service
    .coordinationView()
    .readTask(seeded.taskId)
    .results.find((item) => item.resultId === legacy.resultId);
  assert.ok(result);
  const workspace = await f.service.taskWorkspace(seeded.taskId);
  assert.ok(workspace);
  const domain = f.service.domain();
  const task = domain.task(seeded.taskId);
  const assignment = domain.assignment(result.assignmentId);
  const profile = domain.profile(String(assignment.profileId));
  const project = domain.project(seeded.projectId);
  const identity: RetainedEvidenceIdentity = {
    taskId: seeded.taskId,
    taskVersion: Number(task.version),
    captureTaskVersion: Number(task.version),
    assignmentId: result.assignmentId,
    assignmentVersion: result.assignmentVersion,
    workId: result.workId,
    workRevision: result.workRevision,
    requestSequence: 1,
    conversationRevision: 1,
    instructionsRevision: Number(project.instructionsRevision),
    profileRevision: Number(profile.version),
    profileId: String(profile.id),
    threadId: result.workId,
    turnId: result.workId,
  };
  const comparisonId = randomUUID();
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      repositoryId: null,
      path: "renamed-new.txt",
      previousPath: "renamed-old.txt",
      left: { state: "text", text: "old name content\n" },
      right: { state: "text", text: "new name content\n" },
    }),
  );
  const itemId = randomUUID();
  const candidate: RetainedEvidenceCandidate = {
    version: 1,
    evidenceId: randomUUID(),
    capturedAt: Date.now(),
    identity,
    sourceObservation: {
      comparisonId,
      captureState: "finished",
      outcome: "completed",
      observedAt: Date.now(),
    },
    items: [
      {
        itemId,
        kind: "diff",
        state: "available",
        source: "observed-diff",
        sourceIndex: 0,
        repositoryId: null,
        path: "renamed-new.txt",
        originRoot: workspace.path,
        mime: "application/vnd.ensemble.workspace-diff+json",
        sha256: digest(payload),
        size: payload.byteLength,
        capturedAt: Date.now(),
        observedAt: Date.now(),
        provenance: {
          comparisonId,
          entryIndex: 0,
          change: "renamed",
          previousPath: "renamed-old.txt",
        },
        bytes: Uint8Array.from(payload),
      },
    ],
  };
  const database = new DatabaseSync(
    join(f.directory, "data", "standalone.sqlite"),
  );
  try {
    const store = new RetainedEvidenceStore(database);
    transaction(database, () =>
      store.recordResultWithinTransaction(
        {
          resultId: result.resultId,
          taskId: result.taskId,
          assignmentId: result.assignmentId,
          assignmentVersion: result.assignmentVersion,
          workId: result.workId,
          workRevision: result.workRevision,
        },
        identity,
        candidate,
      ),
    );
  } finally {
    database.close();
  }
  const controlPath = join(workspace.path, "renamed-old.txt");
  const web = await f.startWeb([f.directory, controlPath]);
  t.after(() => web.close());
  const session = await login(web);
  const base =
    web.origin +
    "/api/operator/tasks/" +
    seeded.taskId +
    "/results/" +
    legacy.resultId +
    "/evidence";
  const url = `${base}/${itemId}`;
  const manifestResponse = await fetch(base, {
    headers: { cookie: session.cookie },
  });
  assert.equal(manifestResponse.status, 200);
  const manifest = (await manifestResponse.json()) as {
    data: {
      state: string;
      items: Array<Record<string, unknown> & { itemId: string }>;
    };
  };
  const excluded = manifest.data.items.find((item) => item.itemId === itemId);
  assert.deepEqual(excluded, {
    itemId,
    kind: "diff",
    state: "unavailable",
    reason: "excluded",
  });
  assert.equal(manifest.data.state, "partial");
  const contentResponse = await fetch(url, {
    headers: { cookie: session.cookie },
  });
  assert.equal(contentResponse.status, 200);
  const content = await contentResponse.text();
  for (const secret of [
    "renamed-new.txt",
    "renamed-old.txt",
    "old name content",
    "new name content",
    "provenance",
    "previousPath",
    "originRoot",
    workspace.path,
  ])
    assert.equal(content.includes(secret), false);

  const renamedNewWeb = await f.startWeb([
    f.directory,
    join(workspace.path, "renamed-new.txt"),
  ]);
  t.after(() => renamedNewWeb.close());
  const renamedNewSession = await login(renamedNewWeb);
  const renamedNewManifestResponse = await fetch(
    renamedNewWeb.origin +
      "/api/operator/tasks/" +
      seeded.taskId +
      "/results/" +
      legacy.resultId +
      "/evidence",
    { headers: { cookie: renamedNewSession.cookie } },
  );
  assert.equal(renamedNewManifestResponse.status, 200);
  const renamedNewManifest = (await renamedNewManifestResponse.json()) as {
    data: {
      state: string;
      items: Array<Record<string, unknown> & { itemId: string }>;
    };
  };
  assert.deepEqual(
    renamedNewManifest.data.items.find((item) => item.itemId === itemId),
    {
      itemId,
      kind: "diff",
      state: "unavailable",
      reason: "excluded",
    },
  );
  assert.equal(renamedNewManifest.data.state, "partial");
});

test("retained reads discard results after post-await task, project and exclusion changes", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const captured = await captureNativeResult(f);
  const web = await f.startWeb();
  t.after(() => web.close());
  const session = await login(web);
  const path =
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/results/" +
    captured.resultId +
    "/evidence/" +
    captured.textItem.itemId;
  const original = OperatorApi.prototype.retainedEvidencePolicy;
  const domain = f.service.domain();
  const mutations: Array<() => void> = [
    () =>
      domain.execute({
        type: "task.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: captured.seeded.projectId,
        taskId: captured.seeded.taskId,
        expectedVersion: Number(domain.task(captured.seeded.taskId).version),
        title: "Changed during retained read",
      }),
    () =>
      domain.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: captured.seeded.projectId,
        expectedVersion: Number(
          domain.project(captured.seeded.projectId).version,
        ),
        name: "Changed during retained read",
      }),
    () =>
      domain.execute({
        type: "project.configure",
        actor: "operator",
        key: randomUUID(),
        projectId: captured.seeded.projectId,
        expectedVersion: Number(
          domain.project(captured.seeded.projectId).version,
        ),
        instructions: "retained-proof.txt first second final-without-newline",
      }),
  ];
  try {
    for (const mutate of mutations) {
      let changed = false;
      OperatorApi.prototype.retainedEvidencePolicy = async function (taskId) {
        const policy = await original.call(this, taskId);
        if (!changed) {
          changed = true;
          mutate();
        }
        return policy;
      };
      const response = await fetch(web.origin + path, {
        headers: { cookie: session.cookie },
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.includes('"state":"unavailable"'));
      assert.equal(body.includes("first"), false);
      assert.equal(body.includes("second"), false);
      assert.equal(body.includes("retained-proof.txt"), false);
      assert.equal(body.includes("originRoot"), false);
    }
  } finally {
    OperatorApi.prototype.retainedEvidencePolicy = original;
  }
});

test("the authenticated boundary withholds retained bytes after logout during the read", async (t) => {
  const f = await createOperatorFixture();
  t.after(() => f.close());
  const captured = await captureNativeResult(f);
  const web = await f.startWeb();
  t.after(() => web.close());
  const session = await login(web);
  const path =
    "/api/operator/tasks/" +
    captured.seeded.taskId +
    "/results/" +
    captured.resultId +
    "/evidence/" +
    captured.textItem.itemId;
  const original = OperatorWebBoundary.prototype.read;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const arrival = new Promise<void>((resolve) => (entered = resolve));
  OperatorWebBoundary.prototype.read = async function (
    route,
    query,
    rawSearch,
  ) {
    const data = await original.call(this, route, query, rawSearch);
    if (route === path) {
      entered();
      await gate;
    }
    return data;
  };
  try {
    const pending = fetch(web.origin + path, {
      headers: { cookie: session.cookie },
    });
    await arrival;
    const logout = await fetch(`${web.origin}/api/operator/logout`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin: web.origin,
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
      },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.equal(body.includes("first"), false);
    assert.equal(body.includes("second"), false);
    assert.equal(body.includes("retained-proof.txt"), false);
    assert.equal(body.includes("originRoot"), false);
  } finally {
    release();
    OperatorWebBoundary.prototype.read = original;
  }
});
