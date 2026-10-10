import type {
  CommandReceipt,
  OperatorCommand,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review-contracts.js";
import type {
  workspaceDirectoryReadSchema,
  workspacePreviewReadSchema,
} from "../../src/operator/contracts.js";
import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";
type FeedbackReference = z.infer<typeof feedbackReferenceSchema>;
type WorkspaceDirectory = z.infer<typeof workspaceDirectoryReadSchema>["data"];
type WorkspacePreview = z.infer<typeof workspacePreviewReadSchema>["data"];

export type RangePin = "start" | "end" | null;

export type TaskChangeSelection = {
  entryKey: string;
  path: string;
  repositoryId: string | null;
  context: "branch" | "uncommitted" | "turn";
  comparisonId: string;
  side: "left" | "right";
  currentLine: number;
  rangeAnchorLine: number;
  startLine: number;
  endLine: number;
  contentSha256: string;
  minLine: number;
  maxLine: number;
  /** Edge fixed by Set start/Set end; later selections extend from it. */
  pin: RangePin;
  workId?: string;
  threadId?: string;
  turnId?: string;
};

export class TaskFileTabState {
  constructor(
    readonly key: string,
    readonly scope: WorkspaceDirectory["scope"],
    readonly path: string[],
  ) {}
  preview: WorkspacePreview | null = null;
  previewKey: string | null = null;
  observedAt: number | null = null;
  sourceMode: "rendered" | "source" = "rendered";
  wrapSource = false;
  selectedLine: number | null = null;
  /** Shift-selection origin; the range spans it and selectedLine. */
  rangeAnchorLine: number | null = null;
  /** Set when Set start/Set end fixed one edge; later selections extend from it. */
  rangePin: RangePin = null;
  /** Plain selection replaces the range unless an edge is pinned or Shift extends it. */
  selectLine(line: number, extend: boolean) {
    this.rangeAnchorLine =
      extend || this.rangePin
        ? (this.rangeAnchorLine ?? this.selectedLine)
        : null;
    this.selectedLine = line;
  }
  /** The first press fixes this edge at the selected line; the other press completes the range. */
  setRangeEdge(edge: "start" | "end") {
    if (this.selectedLine === null) return;
    if (this.rangePin && this.rangePin !== edge) this.rangePin = null;
    else {
      this.rangeAnchorLine = this.selectedLine;
      this.rangePin = edge;
    }
  }
  /** Notice for a refreshed preview whose bytes differ from the previous observation. */
  changeNotice = "";
  get selectedRange() {
    if (this.selectedLine === null) return null;
    const anchor = this.rangeAnchorLine ?? this.selectedLine;
    return {
      startLine: Math.min(anchor, this.selectedLine),
      endLine: Math.max(anchor, this.selectedLine),
    };
  }
  readingScrollTop = 0;
  imageScrollLeft = 0;
  imageScrollTop = 0;
  imageFit = true;
  imageZoom = 1;
  pdfScrollLeft = 0;
  pdfScrollTop = 0;
  pdfPage = 1;
  pdfZoom = 1;
}

export class TaskFilesState {
  scope: WorkspaceDirectory["scope"] = { kind: "workspace" };
  path: string[] = [];
  showIgnored = false;
  mobileView: "list" | "preview" = "list";
  tabs: TaskFileTabState[] = [];
  activeTabKey: string | null = null;
  explorerFocusKey: string | null = null;
  returnFocusEntryKey: string | null = null;
  focusAfterDirectoryKey: string | null = null;
  focusEntryAfterNavigation: string | null = null;
  directory: WorkspaceDirectory | null = null;
  directoryKey: string | null = null;
  directoryObservedAt: number | null = null;
  /** Why a direct file link was not opened. */
  linkNotice = "";
  /** Explicitly opens current bytes, e.g. from retained evidence; never implied. */
  openCurrentFile(scope: WorkspaceDirectory["scope"], path: string[]) {
    const key = JSON.stringify([scope, path]);
    if (!this.tabs.some((tab) => tab.key === key))
      this.tabs.push(new TaskFileTabState(key, scope, [...path]));
    this.activeTabKey = key;
    this.scope = scope;
    this.path = path.slice(0, -1);
    this.mobileView = "preview";
  }
}

export class TaskChangesState {
  target: "branch" | "last-turn" | "uncommitted" = "branch";
  repositoryId: string | null = null;
  baseBranchByRepository: Record<string, string> = {};
  baseBranchOptions: string[] = [];
  baseBranchOptionsScopeKey: string | null = null;
  changeSetByRepository: Record<string, "all" | "staged" | "unstaged"> = {};
  layout: "split" | "unified" = "split";
  mobileView: "list" | "preview" = "list";
  selectedEntryKey: string | null = null;
  selection: TaskChangeSelection | null = null;
  notice = "";
  /** Summary of how an explicit Refresh differed from the previous observation. */
  refreshNotice: { key: string; text: string } | null = null;
  comparisonReads: Record<string, WorkspaceComparisonRead["data"]> = {};
  repositoryIds: string[] = [];
  repositoryState: WorkspaceDirectory["state"] | null = null;
  repositoryObservedAt: number | null = null;
  repositoryReadFailed = false;
  readingScrollTop = 0;
}

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
/** Exact source passed to `review.anchor.stage`; never a specimen or a later match. */
export type ReviewAnchorCandidate = {
  taskId: string;
  repositoryId: string | null;
  path: string;
  sourceKind: "workspace-file" | "comparison-side" | "result-evidence";
  context: "workspace" | "branch" | "uncommitted" | "turn" | "result";
  comparisonId?: string;
  resultId?: string;
  resultItemId?: string;
  workId?: string;
  threadId?: string;
  turnId?: string;
  side: "file" | "left" | "right";
  startLine: number;
  endLine: number;
  contentSha256: string;
};

export type LocalReviewSend = {
  key: string;
  expectedDraftVersion: number;
  recipientAssignmentId: string;
  expectedAssignmentVersion: number;
  recipientName: string;
  status: "sending" | "unknown" | "recorded" | "rejected" | "not-recorded";
  reason?: string;
  /** The recorded review resumed a completed lead as a follow-up. */
  resumedLead?: true;
};

/** Client view of the session-owned server draft; private text is never persisted here. */
export class LocalReviewState {
  composer: {
    originKey: string;
    label: string;
    anchor: ReviewAnchorCandidate;
    body: string;
    error: string;
    saving: boolean;
    returnFocus: HTMLElement | null;
  } | null = null;
  editing: Record<string, string> = {};
  summary: string | null = null;
  pending = false;
  notice = "";
  send: LocalReviewSend | null = null;
  inspectKey: string | null = null;
}

/** Reading state for one result's retained evidence; bytes are immutable. */
export class RetainedEvidenceState {
  selectedItemId: string | null = null;
  diffLayout: "split" | "unified" = "split";
  private readonly tabs = new Map<string, TaskFileTabState>();
  tab(itemId: string, scope: WorkspaceDirectory["scope"], path: string[]) {
    let tab = this.tabs.get(itemId);
    if (!tab) {
      tab = new TaskFileTabState(`retained:${itemId}`, scope, path);
      this.tabs.set(itemId, tab);
    }
    return tab;
  }
}

export class TaskWorkspaceState {
  constructor(
    private readonly reply = new TaskReplyState(),
    readonly review = new LocalReviewState(),
  ) {}
  readonly files = new TaskFilesState();
  readonly changes = new TaskChangesState();
  private readonly retainedEvidence = new Map<string, RetainedEvidenceState>();
  retained(resultId: string) {
    let value = this.retainedEvidence.get(resultId);
    if (!value) {
      value = new RetainedEvidenceState();
      this.retainedEvidence.set(resultId, value);
    }
    return value;
  }
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
  private reviews = new Map<string, LocalReviewState>();
  forTask(id: string, entryKey = id) {
    const key = `${id}:${entryKey}`;
    let s = this.states.get(key);
    if (!s) {
      let reply = this.replies.get(id);
      if (!reply) {
        reply = new TaskReplyState();
        this.replies.set(id, reply);
      }
      let review = this.reviews.get(id);
      if (!review) {
        review = new LocalReviewState();
        this.reviews.set(id, review);
      }
      s = new TaskWorkspaceState(reply, review);
      this.states.set(key, s);
    }
    return s;
  }
  purge() {
    this.states.clear();
    this.replies.clear();
    this.reviews.clear();
  }
}
