import {
  selectionSchema,
  type GitHubSourceStore,
} from "../core/github-source.js";
import type { DomainStore } from "../core/domain.js";
import {
  GitHubHttpSourceReader,
  type GitHubSourceReader,
  type IssueReference,
} from "./github-source.js";

export type GitHubReaderFactory = (credentialRef: string) => GitHubSourceReader;

/** Serializes provider reads and commits each selection before the scheduler observes it. */
export class GitHubSynchronizer {
  private pending: Promise<void> | undefined;
  private stopped = false;

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

  private async perform(): Promise<void> {
    for (const project of this.domain.projects()) {
      const projectId = String(project.id);
      const config = this.domain.githubConfiguration(projectId);
      const active = new Set(this.domain.githubActiveSelectionIds(projectId));
      if (!config.credentialRef) continue;
      const reader = this.readerFactory(config.credentialRef);
      for (const raw of config.selections) {
        if (this.stopped) return;
        const selection = selectionSchema.parse(raw);
        if (!active.has(selection.id)) continue;
        const snapshot = await reader.readSelection(selection).catch(() => ({
          complete: false as const,
          issues: [],
          reason: "reader-error",
        }));
        if (this.stopped) return;
        this.sources.reconcileSelection(projectId, selection.id, snapshot);
        if (!snapshot.complete) continue;
        for (const issue of snapshot.issues) {
          const reference: IssueReference = {
            nodeId: issue.nodeId,
            repositoryId: issue.repositoryId,
            repositoryName: issue.repositoryName,
            number: issue.number,
          };
          const blockers = await reader.readBlockers(reference).catch(() => ({
            complete: false,
            blockers: [],
            reason: "reader-error",
          }));
          if (this.stopped) return;
          this.sources.reconcileBlockers(issue.nodeId, blockers);
        }
      }
    }
    for (const retained of this.sources.localBlockerReferences()) {
      if (this.stopped) return;
      const config = this.domain.githubConfiguration(retained.projectId);
      const reader = config.credentialRef
        ? this.readerFactory(config.credentialRef)
        : undefined;
      const status = reader
        ? await reader.readIssueStatus(retained.reference).catch(() => ({
            status: "unknown" as const,
            reason: "reader-error",
          }))
        : { status: "unknown" as const, reason: "missing-credential" };
      if (this.stopped) return;
      this.sources.recordIssueStatus(retained.reference.nodeId, status);
    }
  }
}
