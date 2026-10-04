import type {
  CommandReceipt,
  OperatorCommand,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review.js";
type FeedbackReference = z.infer<typeof feedbackReferenceSchema>;
export class TaskWorkspaceState {
  expanded = new Set<string>();
  chronological = false;
  sourceObservation: "known" | "pending" | "unknown" = "known";
  private drafts = { lead: "", github: "" };
  get draft() {
    return this.drafts[this.destination];
  }
  set draft(value: string) {
    this.drafts[this.destination] = value;
  }
  destination: "lead" | "github" = "lead";
  reference: FeedbackReference | undefined;
  frozen: OperatorCommand | null = null;
  private receipts: {
    lead: CommandReceipt | null;
    github: CommandReceipt | null;
  } = { lead: null, github: null };
  get receipt() {
    return this.receipts[this.destination];
  }
  set receipt(value: CommandReceipt | null) {
    this.receipts[this.destination] = value;
  }
  commentReview: Extract<CommandReceipt, { kind: "comment-review" }> | null =
    null;
  private notices = { lead: "", github: "" };
  get notice() {
    return this.notices[this.destination];
  }
  set notice(value: string) {
    this.notices[this.destination] = value;
  }
  uncertain = false;
  scrollY = 0;
  historyPages: Record<string, number[]> = {};
  omissionHistoryPages: Record<string, number[]> = {};
  focusRecord: string | null = null;
  historyAnchor: { id: string; y: number } | null = null;
  selectedResult: string | null = null;
  selectedSource: string | null = null;
}
export class TaskWorkspaceStates {
  private states = new Map<string, TaskWorkspaceState>();
  forTask(id: string) {
    let s = this.states.get(id);
    if (!s) {
      s = new TaskWorkspaceState();
      this.states.set(id, s);
    }
    return s;
  }
  purge() {
    this.states.clear();
  }
}
