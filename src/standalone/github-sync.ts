import {
  selectionSchema,
  type GitHubSourceStore,
} from "../core/github-source.js";
import type { DomainStore } from "../core/domain.js";
import {
  GitHubHttpSourceReader,
  type BlockerSnapshot,
  type GitHubSourceReader,
  type IssueReference,
  type IssueSnapshot,
  type IssueStatus,
  type SelectionSnapshot,
} from "./github-source.js";

export type GitHubReaderFactory = (credentialRef: string) => GitHubSourceReader;

/** Serializes provider reads and commits each selection before the scheduler observes it. */
export class GitHubSynchronizer {
  private pending: Promise<void> | undefined;
  private stopped = false;
  // Rate-limit pauses per credential, in memory: after a restart GitHub just answers "rate-limited" again.
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly domain: DomainStore,
    private readonly sources: GitHubSourceStore,
    private readonly readerFactory: GitHubReaderFactory = (reference) =>
      new GitHubHttpSourceReader(process.env[reference.slice(4)]),
  ) {}

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    const pending = this.perform().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
  }

  private paused(credentialRef: string): boolean {
    const until = this.pausedUntil.get(credentialRef);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.pausedUntil.delete(credentialRef);
    return false;
  }

  private notePause(
    credentialRef: string,
    result: { reason?: string | null; resumeAt?: number },
  ): void {
    if (result.reason === "rate-limited" && result.resumeAt !== undefined)
      this.pausedUntil.set(credentialRef, result.resumeAt);
  }

  /** Admission consults imported blockers of a closed issue only while its open task continues from its own delivery closure. */
  private readsBlockers(issue: IssueSnapshot): boolean {
    if (issue.state !== "closed") return true;
    const taskId = this.sources.issue(issue.nodeId)?.taskId;
    return (
      taskId !== undefined &&
      this.domain.task(String(taskId)).state === "open" &&
      this.domain.hasOwnDeliveryClosure(String(taskId))
    );
  }

  private async perform(): Promise<void> {
    for (const project of this.domain.projects()) {
      const projectId = String(project.id);
      const config = this.domain.githubConfiguration(projectId);
      const active = new Set(this.domain.githubActiveSelectionIds(projectId));
      const credentialRef = config.credentialRef;
      if (!credentialRef) continue;
      const reader = this.readerFactory(credentialRef);
      for (const raw of config.selections) {
        if (this.stopped) return;
        const selection = selectionSchema.parse(raw);
        if (!active.has(selection.id)) continue;
        const snapshot: SelectionSnapshot = this.paused(credentialRef)
          ? { complete: false, issues: [], reason: "rate-limited" }
          : await reader.readSelection(selection).catch(() => ({
              complete: false as const,
              issues: [],
              reason: "reader-error",
            }));
        if (this.stopped) return;
        this.notePause(credentialRef, snapshot);
        const committed = this.sources.reconcileSelection(
          projectId,
          selection.id,
          snapshot,
          {
            projectId,
            configVersion: config.version,
            credentialRef: config.credentialRef,
          },
        );
        if (!committed) continue;
        if (!snapshot.complete) continue;
        for (const issue of snapshot.issues) {
          if (!this.readsBlockers(issue)) continue;
          const reference: IssueReference = {
            nodeId: issue.nodeId,
            repositoryId: issue.repositoryId,
            repositoryName: issue.repositoryName,
            number: issue.number,
          };
          // Paused issues are recorded as unknown, never left with an earlier "clear".
          const blockers: BlockerSnapshot = this.paused(credentialRef)
            ? { complete: false, blockers: [], reason: "rate-limited" }
            : await reader.readBlockers(reference).catch(() => ({
                complete: false,
                blockers: [],
                reason: "reader-error",
              }));
          if (this.stopped) return;
          this.notePause(credentialRef, blockers);
          this.sources.reconcileBlockers(issue.nodeId, blockers, {
            projectId,
            configVersion: config.version,
            credentialRef: config.credentialRef,
            selectionId: selection.id,
            reference,
          });
        }
      }
    }
    for (const retained of this.sources.localBlockerReferences()) {
      if (this.stopped) return;
      const config = this.domain.githubConfiguration(retained.projectId);
      const credentialRef = config.credentialRef;
      const paused = credentialRef ? this.paused(credentialRef) : false;
      const reader =
        credentialRef && !paused
          ? this.readerFactory(credentialRef)
          : undefined;
      // A paused read must not leave an earlier "closed" clearing a local dependent.
      const status: IssueStatus = paused
        ? { status: "unknown", reason: "rate-limited" }
        : reader
          ? await reader.readIssueStatus(retained.reference).catch(() => ({
              status: "unknown" as const,
              reason: "reader-error",
            }))
          : { status: "unknown", reason: "missing-credential" };
      if (this.stopped) return;
      if (credentialRef) this.notePause(credentialRef, status);
      this.sources.recordIssueStatus(retained.reference.nodeId, status, {
        projectId: retained.projectId,
        configVersion: config.version,
        credentialRef: config.credentialRef,
        reference: retained.reference,
      });
    }
  }
}
