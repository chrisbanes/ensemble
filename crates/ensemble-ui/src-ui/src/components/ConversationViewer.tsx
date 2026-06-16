import { useState } from "react";
import { useStepConversationQuery } from "@/hooks";
import type { TranscriptRecord } from "@/generated/models";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { transcriptRecordDetail } from "@/components/transcript/transcript-model";

interface ConversationViewerProps {
  identifier: string;
  runId: string;
  stepName: string;
  scrollToIndex?: number;
}

function MessageBubble({ record, highlight }: { record: TranscriptRecord; highlight?: boolean }) {
  return (
    <div
      id={`msg-${record.sequence}`}
      className={cn(
        "rounded-lg p-3 border bg-card",
        highlight && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <span className="font-medium capitalize">{record.kind.replace(/_/g, " ")}</span>
        <span>#{record.sequence}</span>
      </div>
      <p className="text-sm whitespace-pre-wrap break-words">{transcriptRecordDetail(record)}</p>
      {record.payload != null && record.kind !== "assistant_message" ? (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:underline">
            Payload
          </summary>
          <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(record.payload, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export default function ConversationViewer({
  identifier,
  runId,
  stepName,
  scrollToIndex,
}: ConversationViewerProps) {
  const [cursor, setCursor] = useState<string | undefined>();
  const { data, isLoading, isError } = useStepConversationQuery(identifier, runId, stepName, {
    cursor: cursor ? Number(cursor) : undefined,
    limit: 50,
  });

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading conversation...</div>;
  }

  if (isError) {
    return <div className="text-center py-8 text-destructive">Failed to load conversation.</div>;
  }

  if (!data || data.records.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">No conversation data.</div>;
  }

  return (
    <div className="space-y-3">
      {data.records.map((record) => (
        <MessageBubble
          key={record.sequence}
          record={record}
          highlight={scrollToIndex === record.sequence}
        />
      ))}

      {data.next_cursor != null && (
        <div className="flex justify-center pt-4 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor(String(data.next_cursor))}
          >
            Load older messages
          </Button>
        </div>
      )}
    </div>
  );
}
