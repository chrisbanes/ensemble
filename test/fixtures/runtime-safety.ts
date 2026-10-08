import { randomUUID } from "node:crypto";
import { coordinationFixture } from "./coordination.js";
import type {
  RuntimeUserInputOutcome,
  RuntimeUserInputRequest,
} from "../../src/standalone/native-input.js";
import type { RuntimeSafetyPort } from "../../src/standalone/runtime-retention.js";

const assignmentId = "40000000-0000-4000-8000-000000000001";
const fixtures = new Set<ReturnType<typeof runtimeSafetyFixture>>();

export function runtimeSafetyFixture() {
  const storage = coordinationFixture();
  const boundTurns = new Map<string, { workId: string; generation: string }>();

  function bindTurn(threadId: string, turnId: string, generation: string) {
    const key = JSON.stringify([threadId, turnId]);
    const existing = boundTurns.get(key);
    if (existing) {
      if (existing.generation !== generation)
        throw new Error("Runtime test turn generation changed");
      return existing.workId;
    }

    const workId = `runtime-${randomUUID()}`;
    storage.addWork(assignmentId, workId, threadId, turnId);
    const revision = storage.db
      .prepare("SELECT workRevision FROM task_work_revisions WHERE workId = ?")
      .get(workId) as { workRevision: number } | undefined;
    if (!revision) throw new Error("Runtime test work revision unavailable");
    storage.db
      .prepare(`INSERT INTO execution_recovery_identities
        (workId, workRevision, requestSequence, processId, processStartedAt,
          bootId, threadId, turnId, runtimeGeneration, terminalEvidenceObserved)
        VALUES (?, ?, 1, NULL, NULL, NULL, ?, NULL, NULL, 0)`)
      .run(workId, revision.workRevision, threadId);
    storage.db
      .prepare(
        "UPDATE execution_intents SET state = 'submitting', turnId = NULL WHERE workId = ?",
      )
      .run(workId);
    const intent = storage.db
      .prepare("SELECT id FROM execution_intents WHERE workId = ?")
      .get(workId) as { id: string } | undefined;
    if (!intent || !storage.state.bindTurn(intent.id, turnId, generation))
      throw new Error("Production runtime turn binding failed");
    boundTurns.set(key, { workId, generation });
    return workId;
  }

  const safety: RuntimeSafetyPort = {
    recordTerminal: (input) => storage.state.recordRuntimeTerminal(input),
    terminal: (threadId, turnId, generation) =>
      storage.state.runtimeTerminal(threadId, turnId, generation),
    terminalForWait: (threadId, turnId, generation) =>
      storage.state.runtimeTerminalForWait(threadId, turnId, generation),
    registerThreadTools: (threadId, digest) =>
      storage.state.registerRuntimeThreadTools(threadId, digest),
    threadQualification: (threadId) =>
      storage.state.runtimeThreadQualification(threadId),
    recordThreadQualification: (input) =>
      storage.state.recordRuntimeThreadQualification(input),
    nativeEndpointHistory: (identity) =>
      storage.coordination.runtimeNativeEndpointHistory(identity),
  };

  const fixture = {
    safety,
    coordination: storage.coordination,
    bindTurn,
    storagePath: storage.filename,
    close: storage.close,
  };
  fixtures.add(fixture);
  return fixture;
}

export function persistRuntimeQuestion(
  fixture: ReturnType<typeof runtimeSafetyFixture>,
  request: RuntimeUserInputRequest,
): void {
  fixture.coordination.recordRuntimeQuestion(request);
}

export function persistRuntimeOutcome(
  fixture: ReturnType<typeof runtimeSafetyFixture>,
  outcome: RuntimeUserInputOutcome,
): void {
  fixture.coordination.recordRuntimeReplyOutcome(outcome);
}

export function closeRuntimeSafetyFixtures(): void {
  for (const fixture of fixtures) fixture.close();
  fixtures.clear();
}
