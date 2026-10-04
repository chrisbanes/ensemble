import { Agent, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createOperatorFixture } from "./fixtures/operator-web.js";
import { seedOwnQuestion } from "./fixtures/questions.js";
import { OperatorApi } from "../src/standalone/operator-api.js";
import { mixedAnswers, mixedForm } from "./fixtures/question-data.js";
import {
  nativeQuestionForm,
  nativeQuestionAnswers,
} from "../src/core/question-forms.js";
import {
  questionCommandRawLimit,
  operatorCommandSchema,
  questionReadSchema,
  inboxReadSchema,
} from "../src/operator/contracts.js";
test("action Inbox is cross-project summary-only, selected form is exact and answer replay precedes changed eligibility", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      b = await seedOwnQuestion(f, mixedForm, "Second task"),
      api = new OperatorApi(f.service, [f.directory]);
    const queue = await api.readInbox();
    assert.equal(queue.data.items.length, 2);
    assert.equal(queue.data.complete, true);
    assert.equal(
      queue.data.items.some((i) => i.projectId === a.projectId),
      true,
    );
    assert.equal(JSON.stringify(queue).includes("options"), false);
    const full = await api.readQuestion(a.taskId, a.interactionId);
    assert.deepEqual(full.data.form, mixedForm);
    assert.equal(full.data.status, "pending");
    questionReadSchema.parse(full);
    inboxReadSchema.parse(queue);
    const command = {
      type: "question.form.answer" as const,
      key: randomUUID(),
      taskId: a.taskId,
      interactionId: a.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    };
    const receipt = await api.execute(command);
    assert.equal(receipt.kind, "coordination");
    assert.equal((await api.readInbox()).data.items.length, 1);
    f.seedPersistedState((db) => {
      db.prepare(
        "UPDATE assignment_conversations SET revision=revision+1 WHERE assignmentId=?",
      ).run(a.assignmentId);
    });
    assert.deepEqual(await api.execute(command), receipt);
    await assert.rejects(api.execute({ ...command, key: randomUUID() }));
    assert.equal(
      (await api.readQuestion(b.taskId, b.interactionId)).data.form?.questions
        .length,
      4,
    );
  } finally {
    await f.close();
  }
});
test("privacy exclusions withhold an entire exact form or stored answer without relabeling options", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      api = new OperatorApi(f.service, ["Blue"]);
    const full = await api.readQuestion(a.taskId, a.interactionId);
    assert.equal(full.data.form, null);
    assert.equal(full.data.status, "unavailable");
    assert.equal(JSON.stringify(full).includes("Blue"), false);
    await assert.rejects(
      api.execute({
        type: "question.form.answer",
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers: mixedAnswers,
      }),
    );
    assert.equal(
      f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
      "open",
    );
  } finally {
    await f.close();
  }
});
test("native adaptation preserves labels/custom and all 32 grouped identities without extending codec shapes", () => {
  const questions = Array.from({ length: 32 }, (_, i) => ({
    id: String(i),
    header: "Place",
    question: "Choose",
    isOther: true,
    isSecret: false as const,
    options: [{ label: "Literal label", description: "Description" }],
  }));
  const form = nativeQuestionForm(questions),
    answers = Object.fromEntries(
      questions.map((q) => [q.id, { optionIds: ["0"], text: "" }]),
    );
  assert.deepEqual(
    nativeQuestionAnswers(form, answers),
    Object.fromEntries(
      questions.map((q) => [q.id, { answers: ["Literal label"] }]),
    ),
  );
  answers["0"] = { optionIds: [], text: " exact custom " };
  assert.equal(
    nativeQuestionAnswers(form, answers)["0"]?.answers[0],
    " exact custom ",
  );
  assert.equal(
    questionCommandRawLimit,
    256 * 1024 +
      new TextEncoder().encode(
        JSON.stringify({
          type: "question.native.answer",
          key: "f".repeat(36),
          taskId: "f".repeat(36),
          interactionId: "f".repeat(36),
          expectedRevision: Number.MAX_SAFE_INTEGER,
          answers: {},
        }),
      ).byteLength -
      2,
  );
  assert.throws(() =>
    operatorCommandSchema.parse({
      type: "question.form.answer",
      key: randomUUID(),
      taskId: randomUUID(),
      interactionId: randomUUID(),
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      answers,
    }),
  );
});

test("curated command stream accepts exactly 256KiB answer plus strict envelope and rejects raw whitespace, escapes and non-question overflow before effects", async () => {
  const f = await createOperatorFixture();
  try {
    const form = {
      version: 1 as const,
      questions: Array.from({ length: 17 }, (_, i) => ({
        id: String(i),
        kind: "free-text" as const,
        label: `Text ${i}`,
        required: true,
      })),
    };
    const a = await seedOwnQuestion(f, form),
      web = await f.startWeb();
    let response = await fetch(web.origin + "/api/operator/session"),
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "",
      session = (await response.json()) as { csrfToken: string };
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    let originalSocket: Socket | undefined;
    const send = async (path: string, body: string) => {
      try {
        return await new Promise<Response>((resolve, reject) => {
          const request = httpRequest(
            web.origin + path,
            {
              method: "POST",
              agent,
              headers: {
                cookie,
                origin: web.origin,
                "x-csrf-token": session.csrfToken,
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
              response.on("error", reject);
              response.on("end", () =>
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode ?? 503,
                    headers: Object.fromEntries(
                      Object.entries(response.headers).map(([key, value]) => [
                        key,
                        Array.isArray(value)
                          ? value.join(",")
                          : String(value ?? ""),
                      ]),
                    ),
                  }),
                ),
              );
            },
          );
          request.on("socket", (socket) => {
            if (originalSocket)
              assert.equal(
                socket,
                originalSocket,
                "Rejected upload must drain before next request on this exact keepalive connection",
              );
            else originalSocket = socket;
          });
          request.on("error", reject);
          request.end(body);
        });
      } catch (error) {
        throw new Error(
          `HTTP boundary ${path} rawBytes=${Buffer.byteLength(body)} prefix=${body.slice(0, 45)} failed`,
          { cause: error },
        );
      }
    };
    try {
      response = await send(
        "/api/operator/login",
        JSON.stringify({ password: web.password }),
      );
      assert.equal(response.status, 200);
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      session = (await response.json()) as { csrfToken: string };
      const answers = Object.fromEntries(
        form.questions.map((q) => [
          q.id,
          { optionIds: [], text: "a".repeat(15000) },
        ]),
      );
      const missing = 256 * 1024 - Buffer.byteLength(JSON.stringify(answers));
      // Distribute exact remaining bytes across legal lower per-field maxima.
      let remaining = missing;
      for (const q of form.questions) {
        const v = answers[q.id]!;
        const add = Math.min(16000 - v.text.length, remaining);
        v.text += "b".repeat(add);
        remaining -= add;
      }
      assert.equal(remaining, 0);
      assert.equal(Buffer.byteLength(JSON.stringify(answers)), 256 * 1024);
      const command = {
        type: "question.form.answer",
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers,
      };
      const bytes = JSON.stringify(command);
      for (const raw of [
        bytes +
          " ".repeat(questionCommandRawLimit - Buffer.byteLength(bytes) + 1),
        bytes.replaceAll("a", "\\u0061"),
        JSON.stringify({
          type: "message",
          key: randomUUID(),
          taskId: a.taskId,
          recipientAssignmentId: a.assignmentId,
          expectedAssignmentVersion: 1,
          message: "x",
        }) + " ".repeat(65536),
      ]) {
        assert.equal((await send("/api/operator/commands", raw)).status, 413);
        assert.equal(
          f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
          "open",
        );
      }
      const overflow = structuredClone(command);
      overflow.answers["0"]!.text += "x";
      assert.notEqual(
        (await send("/api/operator/commands", JSON.stringify(overflow))).status,
        200,
      );
      assert.equal(
        f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
        "open",
      );
      response = await send("/api/operator/commands", bytes);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        ((await response.json()) as { kind: string }).kind,
        "coordination",
      );
      response = await send("/api/operator/commands", bytes);
      assert.equal(response.status, 200);
      assert.equal(
        f.service
          .coordinationView()
          .readTask(a.taskId)
          .messages.filter((m) => m.eventType === "question-answer").length,
        1,
      );
      assert.equal(
        (await send("/api/operator/source-refresh", "{}" + " ".repeat(65536)))
          .status,
        413,
      );
      assert.equal((await send("/api/operator/commands", bytes)).status, 200);
    } finally {
      agent.destroy();
    }
  } finally {
    await f.close();
  }
});

test("logout during an authenticated held upload rejects before answer persistence and effect", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      web = await f.startWeb();
    let response = await fetch(web.origin + "/api/operator/session"),
      cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "",
      session = (await response.json()) as { csrfToken: string };
    const headers = () => ({
      cookie,
      origin: web.origin,
      "x-csrf-token": session.csrfToken,
      "content-type": "application/json",
    });
    response = await fetch(web.origin + "/api/operator/login", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ password: web.password }),
    });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    session = (await response.json()) as { csrfToken: string };
    const command = {
        type: "question.form.answer",
        key: randomUUID(),
        taskId: a.taskId,
        interactionId: a.interactionId,
        expectedRevision: 1,
        answers: mixedAnswers,
      },
      bytes = JSON.stringify(command);
    let upload!: ReturnType<typeof httpRequest>;
    let continued!: () => void;
    const initial = new Promise<void>((resolve) => {
      continued = resolve;
    });
    const completed = new Promise<number>((resolve, reject) => {
      upload = httpRequest(
        web.origin + "/api/operator/commands",
        {
          method: "POST",
          headers: {
            ...headers(),
            expect: "100-continue",
            "content-length": Buffer.byteLength(bytes),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 503));
          res.on("error", reject);
        },
      );
      upload.on("error", reject);
      upload.on("continue", continued);
      upload.flushHeaders();
    });
    await initial;
    upload.write(bytes.slice(0, 40));
    response = await fetch(web.origin + "/api/operator/logout", {
      method: "POST",
      headers: headers(),
      body: "{}",
    });
    assert.equal(response.status, 200);
    await response.text();
    upload.end(bytes.slice(40));
    assert.equal(await completed, 401);
    assert.equal(
      f.service.coordinationView().readTask(a.taskId).questions[0]?.status,
      "open",
    );
    assert.equal(
      f.service
        .coordinationView()
        .readTask(a.taskId)
        .messages.filter((m) => m.eventType === "question-answer").length,
      0,
    );
    f.seedPersistedState((db) => {
      const count = db
        .prepare(
          "SELECT COUNT(*) AS n FROM coordination_operator_receipts WHERE commandKey=?",
        )
        .get(command.key) as { n: number };
      assert.equal(count.n, 0);
    });
    assert.equal(f.runtime.turns, 1);
  } finally {
    await f.close();
  }
});

test("Inbox revalidates earlier workspace and task binding after later row awaits", async () => {
  for (const mutation of ["workspace", "task"] as const) {
    const f = await createOperatorFixture();
    try {
      const a = await seedOwnQuestion(f),
        b = await seedOwnQuestion(f, mixedForm, "Later row");
      const catalog = f.service.domain().taskCatalog(),
        first = catalog[0]!,
        last = catalog.at(-1)!;
      const original = f.service.taskWorkspace.bind(f.service);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
          enter = r;
        }),
        barrier = new Promise<void>((r) => {
          release = r;
        });
      let held = false;
      f.service.taskWorkspace = async (id: string) => {
        if (id === last.id && !held) {
          held = true;
          enter();
          await barrier;
        }
        return original(id);
      };
      const read = new OperatorApi(f.service, [f.directory]).readInbox();
      await entered;
      if (mutation === "workspace")
        f.seedPersistedState((db) => {
          db.prepare("DELETE FROM task_workspace_bindings WHERE taskId=?").run(
            first.id,
          );
        });
      else
        f.service.domain().execute({
          type: "task.configure",
          actor: "operator",
          key: randomUUID(),
          projectId: first.projectId,
          taskId: first.id,
          expectedVersion: Number(f.service.domain().task(first.id).version),
          title: "Changed while later row held",
        });
      release();
      await assert.rejects(read, /unavailable/);
      assert.notEqual(a.taskId, b.taskId);
    } finally {
      await f.close();
    }
  }
});

test("Inbox combines approval/question age across 100-row pages and exact selection outside page", async () => {
  const f = await createOperatorFixture();
  try {
    const a = await seedOwnQuestion(f),
      b = await seedOwnQuestion(f, mixedForm, "Other project queue"),
      api = new OperatorApi(f.service, [f.directory]);
    const generated: string[] = [];
    f.seedPersistedState((db) => {
      const insert = db.prepare(
        "INSERT INTO coordination_interactions(interactionId,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,kind,status,prompt,action,materialHash,revision,createdAt,updatedAt) SELECT ?,taskId,requestingAssignmentId,requestingWorkId,requestingWorkRevision,requestingAssignmentVersion,conversationRevision,?,'open','Page fixture',?, ?,1,?,? FROM coordination_interactions WHERE interactionId=?",
      );
      for (let i = 0; i < 101; i++) {
        const id = randomUUID();
        generated.push(id);
        insert.run(
          id,
          i % 2 ? "approval" : "question",
          i % 2 ? "Review fixture" : null,
          i % 2 ? "a".repeat(64) : null,
          i + 1,
          i + 1,
          a.interactionId,
        );
      }
    });
    const first = await api.readInbox();
    assert.equal(first.data.items.length, 100);
    assert.equal(first.data.complete, false);
    assert.ok(first.data.nextCursor);
    assert.deepEqual(
      first.data.items.slice(0, 3).map((item) => item.kind),
      ["question", "approval", "question"],
    );
    assert.deepEqual(
      first.data.items.slice(0, 3).map((item) => item.createdAt),
      [1000, 2000, 3000],
    );
    const second = await api.readInbox(
      new URLSearchParams({ cursor: first.data.nextCursor! }),
    );
    assert.equal(second.data.items.length, 3);
    assert.equal(second.data.complete, true);
    assert.equal(
      new Set(
        [...first.data.items, ...second.data.items].map((item) => item.id),
      ).size,
      103,
    );
    assert.ok(!first.data.items.some((item) => item.id === b.interactionId));
    assert.equal(
      (await api.readQuestion(b.taskId, b.interactionId)).data.form?.questions
        .length,
      4,
    );
    await api.execute({
      type: "question.form.answer",
      key: randomUUID(),
      taskId: a.taskId,
      interactionId: a.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    });
    await assert.rejects(
      api.readInbox(new URLSearchParams({ cursor: first.data.nextCursor! })),
      /conflict/,
    );
  } finally {
    await f.close();
  }
});
