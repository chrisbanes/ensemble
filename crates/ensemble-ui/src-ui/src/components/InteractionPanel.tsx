import { useState, type ChangeEvent } from "react";
import type { InteractionDetail } from "@/generated/models";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

interface InteractionPanelProps {
  interaction: InteractionDetail;
  issueIdentifier: string;
  onSubmitInput: (response: string) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
  isCancelling?: boolean;
}

export default function InteractionPanel({
  interaction,
  issueIdentifier,
  onSubmitInput,
  onCancel,
  isSubmitting = false,
  isCancelling = false,
}: InteractionPanelProps) {
  const [textResponse, setTextResponse] = useState("");

  const isResolved = interaction.status === "resolved";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{interaction.question}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{issueIdentifier}</p>
        </div>
        <Badge variant="outline">{interaction.status}</Badge>
      </div>

      {interaction.why_blocked && (
        <p className="text-sm text-muted-foreground bg-muted/20 rounded-lg border p-3">
          {interaction.why_blocked}
        </p>
      )}

      {interaction.suggested_answer && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-100">
          <span className="font-medium">Suggested:</span> {interaction.suggested_answer}
        </div>
      )}

      {interaction.extra_context && (
        <div className="rounded-lg border bg-muted/20 p-4 text-sm">
          <span className="font-medium text-muted-foreground">Context:</span> {interaction.extra_context}
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span>Step: {interaction.step_name}</span>
      </div>

      {!isResolved && (
        <div className="space-y-3">
          <Textarea
            id="interaction-response"
            value={textResponse}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setTextResponse(event.target.value)
            }
            placeholder="Answer the agent's question"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => onSubmitInput(textResponse)}
              disabled={isSubmitting || textResponse.trim().length === 0}
            >
              Submit Input
            </Button>
            <Button variant="outline" onClick={onCancel} disabled={isCancelling}>
              Cancel Request
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
