import type {
  CommandReceipt,
  OperatorCommand,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review.js";
type FeedbackReference = z.infer<typeof feedbackReferenceSchema>;
class TaskReplyState {
  sourceObservation: "known" | "pending" | "unknown" = "known";
  sourceRefreshFailed = false;
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
}
export class TaskWorkspaceState {
  constructor(private readonly reply = new TaskReplyState()) {}
  expanded = new Set<string>();
  chronological = false;
  get sourceObservation() {
    return this.reply.sourceObservation;
  }
  set sourceObservation(value: TaskReplyState["sourceObservation"]) {
    this.reply.sourceObservation = value;
  }
  get sourceRefreshFailed() {
    return this.reply.sourceRefreshFailed;
  }
  set sourceRefreshFailed(value: TaskReplyState["sourceRefreshFailed"]) {
    this.reply.sourceRefreshFailed = value;
  }
  get draft() {
    return this.reply.draft;
  }
  set draft(value: TaskReplyState["draft"]) {
    this.reply.draft = value;
  }
  get destination() {
    return this.reply.destination;
  }
  set destination(value: TaskReplyState["destination"]) {
    this.reply.destination = value;
  }
  get reference() {
    return this.reply.reference;
  }
  set reference(value: TaskReplyState["reference"]) {
    this.reply.reference = value;
  }
  get frozen() {
    return this.reply.frozen;
  }
  set frozen(value: TaskReplyState["frozen"]) {
    this.reply.frozen = value;
  }
  get receipt() {
    return this.reply.receipt;
  }
  set receipt(value: TaskReplyState["receipt"]) {
    this.reply.receipt = value;
  }
  get commentReview() {
    return this.reply.commentReview;
  }
  set commentReview(value: TaskReplyState["commentReview"]) {
    this.reply.commentReview = value;
  }
  get notice() {
    return this.reply.notice;
  }
  set notice(value: TaskReplyState["notice"]) {
    this.reply.notice = value;
  }
  get uncertain() {
    return this.reply.uncertain;
  }
  set uncertain(value: TaskReplyState["uncertain"]) {
    this.reply.uncertain = value;
  }
  scrollY = 0;
  historyPages: Record<string, number[]> = {};
  omissionHistoryPages: Record<string, number[]> = {};
  focusRecord: string | null = null;
  focusHref: string | null = null;
  historyAnchor: { id: string; y: number } | null = null;
  selectionInitialized = false;
  selectedResult: string | null = null;
  selectedSource: string | null = null;
}
export class TaskWorkspaceStates {
  private states = new Map<string, TaskWorkspaceState>();
  private replies = new Map<string, TaskReplyState>();
  forTask(id: string, entryKey = id) {
    const key = `${id}:${entryKey}`;
    let s = this.states.get(key);
    if (!s) {
      let reply = this.replies.get(id);
      if (!reply) {
        reply = new TaskReplyState();
        this.replies.set(id, reply);
      }
      s = new TaskWorkspaceState(reply);
      this.states.set(key, s);
    }
    return s;
  }
  purge() {
    this.states.clear();
    this.replies.clear();
  }
}
