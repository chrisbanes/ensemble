import type { Assignment, Store } from "./store.js";

export interface WorkerHost {
  spawn(assignment: Assignment): Promise<string>;
  find(assignment: Assignment): Promise<string[]>;
}

export class Coordinator {
  constructor(
    private readonly store: Store,
    private readonly host: WorkerHost,
  ) {}

  async launch(id: string): Promise<Assignment> {
    if (!this.store.beginLaunch(id)) return this.store.get(id);
    // Persist intent before crossing the BB API boundary. Any throw leaves an
    // uncertain launch that may only be reconciled, never automatically retried.
    const threadId = await this.host.spawn(this.store.get(id));
    this.store.attach(id, threadId);
    return this.store.get(id);
  }

  async reconcile(): Promise<void> {
    const ambiguous: string[] = [];
    for (const assignment of this.store.list()) {
      if (assignment.state !== "launching") continue;
      const matches = await this.host.find(assignment);
      if (matches.length > 1) {
        ambiguous.push(assignment.id);
        continue;
      }
      if (matches[0]) this.store.attach(assignment.id, matches[0]);
      // Zero matches isn't proof that an earlier request cannot still finish.
    }
    if (ambiguous.length)
      throw new Error(
        `Multiple BB threads for assignments ${ambiguous.join(", ")}; operator resolution required`,
      );
  }
}
