import type {
  CommandReceipt,
  OperatorCommand,
} from "../../src/operator/contracts.js";
import type { z } from "zod";
import type { feedbackReferenceSchema } from "../../src/core/task-review.js";
import type {
  workspaceDirectoryReadSchema,
  workspacePreviewReadSchema,
} from "../../src/operator/contracts.js";
import type { WorkspaceComparisonRead } from "../../src/operator/contracts.js";
type FeedbackReference = z.infer<typeof feedbackReferenceSchema>;
type WorkspaceDirectory = z.infer<typeof workspaceDirectoryReadSchema>["data"];
type WorkspacePreview = z.infer<typeof workspacePreviewReadSchema>["data"];

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
  rangeStartSet: boolean;
  rangeEndSet: boolean;
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
/** Reading state for one result's retained evidence; bytes are immutable. */
export class RetainedEvidenceState {
  selectedItemId: string | null = null;
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
  constructor(private readonly reply = new TaskReplyState()) {}
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
