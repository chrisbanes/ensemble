import { useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IssueQuestionBanner, type PendingQuestion } from "./IssueQuestionBanner";

interface IssueComposerProps {
  pendingQuestion: PendingQuestion | null;
  onSubmitReply: (value: string) => void;
  onSubmitFollowUp: (value: string) => void;
  isSubmitting: boolean;
}

export function IssueComposer({
  pendingQuestion,
  onSubmitReply,
  onSubmitFollowUp,
  isSubmitting,
}: IssueComposerProps) {
  const [value, setValue] = useState("");
  const isQuestionMode = pendingQuestion !== null;

  const handleSubmit = () => {
    if (isQuestionMode) {
      onSubmitReply(value);
    } else {
      onSubmitFollowUp(value);
    }
    setValue("");
  };

  return (
    <div className="border-t bg-background p-4 space-y-3">
      {pendingQuestion ? <IssueQuestionBanner pendingQuestion={pendingQuestion} /> : null}
      <label htmlFor="issue-composer" className="text-sm font-medium">
        {isQuestionMode ? "Reply" : "Follow-up"}
      </label>
      <Textarea
        id="issue-composer"
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setValue(event.target.value)}
        placeholder={isQuestionMode ? "Answer the agent question" : "Add operator guidance"}
      />
      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={isSubmitting || value.trim().length === 0}>
          {isQuestionMode ? "Submit Reply" : "Send Follow-up"}
        </Button>
      </div>
    </div>
  );
}
