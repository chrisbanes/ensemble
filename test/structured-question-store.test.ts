import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { coordinationFixture } from "./fixtures/coordination.js";
import { mixedForm, mixedAnswers } from "./fixtures/question-data.js";
const task = "20000000-0000-4000-8000-000000000001",
  assignment = "40000000-0000-4000-8000-000000000001";
const call = {
  threadId: "thread-child-a",
  turnId: "turn-child-a",
  callId: "full-question",
  tool: "ensemble_ask_question",
  arguments: { form: mixedForm },
};
function request(f: ReturnType<typeof coordinationFixture>) {
  f.coordination.requestQuestion(call);
  return f.coordination.interactions(task)[0]!;
}
test("full request/answer transaction replay survives two reopens and preserves original work attribution", () => {
  const f = coordinationFixture();
  try {
    const q = request(f);
    assert.deepEqual(
      f.coordination.questionForm(q.interactionId)?.form,
      mixedForm,
    );
    f.coordination.requestQuestion(call);
    assert.equal(f.coordination.interactions(task).length, 1);
    assert.throws(() =>
      f.coordination.requestQuestion({
        ...call,
        arguments: { form: { ...mixedForm, questions: [] } },
      }),
    );
    f.db
      .prepare(
        "UPDATE execution_intents SET state='completed' WHERE workId='work-child-a'",
      )
      .run();
    const command = {
      actor: "operator" as const,
      key: randomUUID(),
      interactionId: q.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    };
    const event = f.coordination.answerQuestionForm(command);
    const independent = new DatabaseSync(f.filename);
    try {
      assert.equal(
        independent
          .prepare(
            "SELECT answerJson FROM coordination_question_forms WHERE interactionId=?",
          )
          .get(q.interactionId)?.answerJson,
        JSON.stringify(mixedAnswers),
      );
      assert.equal(
        independent
          .prepare(
            "SELECT COUNT(*) AS n FROM coordination_operator_receipts WHERE commandKey=?",
          )
          .get(command.key)?.n,
        1,
      );
    } finally {
      independent.close();
    }
    assert.equal(event.recipientAssignmentId, assignment);
    const payload = JSON.parse(event.payload);
    assert.deepEqual(payload.answers, mixedAnswers);
    assert.equal(payload.requestingWorkId, "work-child-a");
    for (let i = 0; i < 2; i++) {
      f.reopen();
      assert.deepEqual(f.coordination.answerQuestionForm(command), event);
      assert.deepEqual(
        f.coordination.questionForm(q.interactionId)?.answers,
        mixedAnswers,
      );
    }
    assert.equal(f.coordination.inboxEvents(assignment).length, 1);
    assert.throws(() =>
      f.coordination.answerQuestionForm({ ...command, key: randomUUID() }),
    );
    assert.throws(() =>
      f.coordination.answerQuestionForm({
        ...command,
        answers: {
          ...mixedAnswers,
          notes: { optionIds: [], text: "different" },
        },
      }),
    );
  } finally {
    f.close();
  }
});
test("failed receipt rolls back schema answer, attention and event then retry records one", () => {
  const f = coordinationFixture();
  try {
    const q = request(f);
    const command = {
      actor: "operator" as const,
      key: randomUUID(),
      interactionId: q.interactionId,
      expectedRevision: 1,
      answers: mixedAnswers,
    };
    f.db.exec(
      "CREATE TRIGGER fail_form_receipt BEFORE INSERT ON coordination_operator_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
    );
    assert.throws(() => f.coordination.answerQuestionForm(command), /injected/);
    assert.equal(f.coordination.questionForm(q.interactionId)?.answers, null);
    assert.equal(f.coordination.inboxEvents(assignment).length, 0);
    assert.equal(f.coordination.interactions(task)[0]?.status, "open");
    f.db.exec("DROP TRIGGER fail_form_receipt");
    f.coordination.answerQuestionForm(command);
    assert.equal(f.coordination.inboxEvents(assignment).length, 1);
  } finally {
    f.close();
  }
});
test("own question survives unrelated and same-assignment ordinary work, but rejects actual replacement and cancellation", () => {
  for (const mode of [
    "unrelated",
    "continuation",
    "replacement",
    "cancelled",
    "completed-assignment",
    "superseded",
  ]) {
    const f = coordinationFixture();
    try {
      const q = request(f);
      f.db
        .prepare(
          "UPDATE execution_intents SET state='completed' WHERE workId='work-child-a'",
        )
        .run();
      if (mode === "unrelated")
        f.addWork(
          "40000000-0000-4000-8000-000000000003",
          "other-b",
          "other-thread",
          "other-turn",
        );
      if (mode === "continuation")
        f.addWork(assignment, "continuation-a", "next-thread", "next-turn");
      if (mode === "replacement")
        f.db
          .prepare(
            "UPDATE assignment_conversations SET revision=revision+1 WHERE assignmentId=?",
          )
          .run(assignment);
      if (mode === "cancelled")
        f.db
          .prepare(
            "UPDATE execution_intents SET state='resolved-failed' WHERE workId='work-child-a'",
          )
          .run();
      if (mode === "completed-assignment")
        f.db
          .prepare("UPDATE domain_assignments SET state='completed' WHERE id=?")
          .run(assignment);
      if (mode === "superseded")
        f.db
          .prepare(
            "UPDATE coordination_question_forms SET requestState='superseded' WHERE interactionId=?",
          )
          .run(q.interactionId);
      const submit = () =>
        f.coordination.answerQuestionForm({
          actor: "operator",
          key: randomUUID(),
          interactionId: q.interactionId,
          expectedRevision: 1,
          answers: mixedAnswers,
        });
      if (mode === "unrelated" || mode === "continuation")
        assert.equal(submit().recipientAssignmentId, assignment);
      else {
        assert.throws(submit);
        assert.equal(f.coordination.inboxEvents(assignment).length, 0);
      }
    } finally {
      f.close();
    }
  }
});

test("additive form migration preserves populated plain question and receipt bytes across two reopens", () => {
  const f = coordinationFixture();
  try {
    f.coordination.requestQuestion({
      ...call,
      arguments: { question: "Original plain request" },
    });
    const q = f.coordination.interactions(task)[0]!,
      command = {
        actor: "operator" as const,
        key: randomUUID(),
        interactionId: q.interactionId,
        expectedRevision: 1,
        answer: "Original exact answer",
      };
    const event = f.coordination.answerQuestion(command),
      before = f.db
        .prepare("SELECT * FROM coordination_operator_receipts")
        .all();
    f.db.exec("DROP TABLE coordination_question_forms");
    for (let i = 0; i < 2; i++) {
      f.reopen();
      assert.deepEqual(
        f.db.prepare("SELECT * FROM coordination_operator_receipts").all(),
        before,
      );
      assert.deepEqual(f.coordination.answerQuestion(command), event);
      assert.equal(
        f.coordination.interactions(task)[0]?.prompt,
        "Original plain request",
      );
      assert.equal(
        f.coordination.interactions(task)[0]?.response,
        "Original exact answer",
      );
    }
  } finally {
    f.close();
  }
});
test("request schema failure rolls back interaction attention and callback receipt before retry", () => {
  const f = coordinationFixture();
  try {
    f.db.exec(
      "CREATE TRIGGER fail_form_schema BEFORE INSERT ON coordination_question_forms BEGIN SELECT RAISE(ABORT,'injected schema failure'); END",
    );
    assert.throws(() => request(f), /injected schema failure/);
    assert.equal(f.coordination.interactions(task).length, 0);
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM coordination_question_forms")
        .get()?.n,
      0,
    );
    f.db.exec("DROP TRIGGER fail_form_schema");
    request(f);
    f.coordination.requestQuestion(call);
    assert.equal(f.coordination.interactions(task).length, 1);
  } finally {
    f.close();
  }
});
