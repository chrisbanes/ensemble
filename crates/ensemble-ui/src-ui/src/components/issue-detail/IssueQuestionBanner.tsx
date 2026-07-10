import { Card } from "@/components/ui/card";
import type { InteractionKind, InteractionStatus } from "@/generated/models";

export interface PendingQuestion {
  interactionId: string;
  kind: InteractionKind;
  status: InteractionStatus;
  awaitingResume: boolean;
  question: string;
  whyBlocked: string | null;
  suggestedAnswer: string | null;
  stepName: string | null;
}

interface IssueQuestionBannerProps {
  pendingQuestion: PendingQuestion;
}

export function IssueQuestionBanner({ pendingQuestion }: IssueQuestionBannerProps) {
  return (
    <Card className="border-blue-300 bg-blue-50/60 p-3 dark:border-blue-900 dark:bg-blue-950/20">
      <div className="text-xs font-medium uppercase text-blue-700 dark:text-blue-200">
        {pendingQuestion.status === "resolved" ? "Response recorded" : "Waiting for human input"}
      </div>
      <div className="mt-1 font-semibold">{pendingQuestion.question}</div>
      {pendingQuestion.whyBlocked ? (
        <p className="mt-1 text-sm text-muted-foreground">{pendingQuestion.whyBlocked}</p>
      ) : null}
      {pendingQuestion.suggestedAnswer ? (
        <p className="mt-1 text-sm">Suggested: {pendingQuestion.suggestedAnswer}</p>
      ) : null}
      {pendingQuestion.stepName ? (
        <p className="mt-1 text-xs text-muted-foreground">Step: {pendingQuestion.stepName}</p>
      ) : null}
    </Card>
  );
}
