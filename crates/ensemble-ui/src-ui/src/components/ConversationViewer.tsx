import { useState } from "react";
import { useConversationQuery } from "@/hooks";
import type { ConversationMessage } from "@/generated/models";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ConversationViewerProps {
  identifier: string;
  scrollToIndex?: number;
}

function MessageBubble({ msg, highlight }: { msg: ConversationMessage; highlight?: boolean }) {
  return (
    <div
      id={`msg-${msg.index}`}
      className={cn(
        "rounded-lg p-3 border bg-card",
        highlight && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <span className="font-medium capitalize">{msg.role}</span>
        <span>#{msg.index}</span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
      {msg.tool_calls != null && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:underline">
            Tool calls
          </summary>
          <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {JSON.stringify(msg.tool_calls, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function ConversationViewer({ identifier, scrollToIndex }: ConversationViewerProps) {
  const [cursor, setCursor] = useState<string | undefined>();
  const { data, isLoading, isError } = useConversationQuery(identifier, cursor);

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading conversation...</div>;
  }

  if (isError) {
    return <div className="text-center py-8 text-destructive">Failed to load conversation.</div>;
  }

  if (!data || data.messages.length === 0) {
    return <div className="text-center py-8 text-muted-foreground">No conversation data.</div>;
  }

  return (
    <div className="space-y-3">
      {data.messages.map((msg) => (
        <MessageBubble
          key={msg.index}
          msg={msg}
          highlight={scrollToIndex === msg.index}
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
