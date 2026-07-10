import { useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IssueQuestionBanner, type PendingQuestion } from "./IssueQuestionBanner";

export type IssueInteractionReply =
  | { kind: "question"; text: string }
  | { kind: "approval"; approved: boolean; reason: string }
  | { kind: "handoff"; completed: boolean; notes: string };

interface IssueComposerProps {
  pendingQuestion: PendingQuestion | null;
  onSubmitReply: (reply: IssueInteractionReply) => Promise<boolean> | boolean;
  onSubmitFollowUp: (value: string) => Promise<boolean> | boolean;
  onResumeInteraction?: () => Promise<boolean> | boolean;
  isSubmitting: boolean;
  error?: string | null;
}

export function IssueComposer({
  pendingQuestion,
  onSubmitReply,
  onSubmitFollowUp,
  onResumeInteraction,
  isSubmitting,
  error = null,
}: IssueComposerProps) {
  const [value, setValue] = useState("");
  const isQuestionMode = pendingQuestion !== null;

  const submit = async (reply: IssueInteractionReply) => {
    const submitted = await onSubmitReply(reply);
    if (submitted) {
      setValue("");
    }
  };

  const handleSubmit = async () => {
    const submitted = await onSubmitFollowUp(value);
    if (submitted) setValue("");
  };

  const interactionControls = (() => {
    if (!pendingQuestion) return null;

    if (pendingQuestion.status === "resolved" && pendingQuestion.awaitingResume) {
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The response was recorded, but the issue still needs to resume.
          </p>
          <Button onClick={() => onResumeInteraction?.()} disabled={isSubmitting}>
            Resume issue
          </Button>
        </div>
      );
    }

    switch (pendingQuestion.kind) {
      case "question":
        return (
          <>
            <label htmlFor="issue-composer" className="text-sm font-medium">
              Reply
            </label>
            <Textarea
              id="issue-composer"
              value={value}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
              placeholder="Answer the agent question"
            />
            <Button
              onClick={() => submit({ kind: "question", text: value })}
              disabled={isSubmitting || value.trim().length === 0}
            >
              Submit Reply
            </Button>
          </>
        );
      case "approval":
        return (
          <>
            <label htmlFor="issue-composer" className="text-sm font-medium">
              Reason (optional)
            </label>
            <Textarea
              id="issue-composer"
              value={value}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
              placeholder="Add context for this decision"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => submit({ kind: "approval", approved: false, reason: value })} disabled={isSubmitting}>
                Reject
              </Button>
              <Button onClick={() => submit({ kind: "approval", approved: true, reason: value })} disabled={isSubmitting}>
                Approve
              </Button>
            </div>
          </>
        );
      case "handoff":
        return (
          <>
            <label htmlFor="issue-composer" className="text-sm font-medium">
              Notes (optional)
            </label>
            <Textarea
              id="issue-composer"
              value={value}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
              placeholder="Describe the handoff outcome"
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => submit({ kind: "handoff", completed: false, notes: value })} disabled={isSubmitting}>
                Incomplete
              </Button>
              <Button onClick={() => submit({ kind: "handoff", completed: true, notes: value })} disabled={isSubmitting}>
                Complete
              </Button>
            </div>
          </>
        );
      default: {
        const exhaustive: never = pendingQuestion.kind;
        return exhaustive;
      }
    }
  })();

  return (
    <div className="border-t bg-background p-4 space-y-3">
      {pendingQuestion ? <IssueQuestionBanner pendingQuestion={pendingQuestion} /> : null}
      {isQuestionMode ? (
        interactionControls
      ) : (
        <>
          <label htmlFor="issue-composer" className="text-sm font-medium">
            Follow-up
          </label>
          <Textarea
            id="issue-composer"
            value={value}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
            placeholder="Add operator guidance"
          />
          <Button onClick={handleSubmit} disabled={isSubmitting || value.trim().length === 0}>
            Send Follow-up
          </Button>
        </>
      )}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
