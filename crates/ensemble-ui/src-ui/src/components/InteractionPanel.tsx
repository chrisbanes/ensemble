import { useState, type ChangeEvent } from "react";
import type { InteractionRequest, InteractionResponseBody } from "@/generated/models";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

interface InteractionPanelProps {
  interaction: InteractionRequest;
  issueIdentifier: string;
  onRespond: (payload: InteractionResponseBody) => void;
  onCancel: () => void;
  onResume: () => void;
  isResponding?: boolean;
  isCancelling?: boolean;
  isResuming?: boolean;
}

function renderResponseSummary(interaction: InteractionRequest) {
  if (!interaction.response) return null;

  switch (interaction.response.kind) {
    case "question":
      return interaction.response.text;
    case "approval":
      return interaction.response.approved
        ? "Approved"
        : interaction.response.reason || "Rejected";
    case "handoff":
      return interaction.response.completed
        ? interaction.response.notes || "Completed"
        : interaction.response.notes || "Pending";
  }
}

export default function InteractionPanel({
  interaction,
  issueIdentifier,
  onRespond,
  onCancel,
  onResume,
  isResponding = false,
  isCancelling = false,
  isResuming = false,
}: InteractionPanelProps) {
  const [textResponse, setTextResponse] = useState("");

  const isResolved = interaction.status === "resolved";
  const responseSummary = renderResponseSummary(interaction);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">{interaction.title}</h3>
            <Badge variant={interaction.blocking ? "secondary" : "outline"}>
              {interaction.blocking ? "Blocking" : "Info"}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{issueIdentifier}</p>
        </div>
        <Badge variant="outline">{interaction.kind}</Badge>
      </div>

      <div className="rounded-lg border bg-muted/20 p-4 space-y-2">
        <p className="text-sm leading-6">{interaction.body}</p>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>Step: {interaction.step_name}</span>
          <span>Status: {interaction.status}</span>
        </div>
      </div>

      {interaction.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {interaction.options.map((option) => (
            <Badge key={option} variant="outline">
              {option}
            </Badge>
          ))}
        </div>
      )}

      {responseSummary && (
        <div className="rounded-lg border border-green-200 bg-green-50/60 p-4 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/20 dark:text-green-100">
          Latest response: {responseSummary}
        </div>
      )}

      {!isResolved && interaction.kind === "question" && (
        <div className="space-y-3">
          <label htmlFor="interaction-response" className="text-sm font-medium">
            Response
          </label>
          <Textarea
            id="interaction-response"
            value={textResponse}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setTextResponse(event.target.value)
            }
            placeholder="Add the operator response"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                onRespond({
                  kind: "question",
                  response_schema_version: 1,
                  text: textResponse,
                  selected_option: null,
                })
              }
              disabled={isResponding || textResponse.trim().length === 0}
            >
              Send Response
            </Button>
            <Button variant="outline" onClick={onCancel} disabled={isCancelling}>
              Cancel Request
            </Button>
          </div>
        </div>
      )}

      {!isResolved && interaction.kind === "approval" && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              onRespond({
                kind: "approval",
                response_schema_version: 1,
                approved: true,
                reason: null,
              })
            }
            disabled={isResponding}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              onRespond({
                kind: "approval",
                response_schema_version: 1,
                approved: false,
                reason: "Needs changes",
              })
            }
            disabled={isResponding}
          >
            Reject
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={isCancelling}>
            Cancel Request
          </Button>
        </div>
      )}

      {!isResolved && interaction.kind === "handoff" && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              onRespond({
                kind: "handoff",
                response_schema_version: 1,
                completed: true,
                notes: textResponse || null,
              })
            }
            disabled={isResponding}
          >
            Mark Complete
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={isCancelling}>
            Cancel Request
          </Button>
        </div>
      )}

      {isResolved && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onResume} disabled={isResuming}>
            Resume Issue
          </Button>
        </div>
      )}
    </div>
  );
}
