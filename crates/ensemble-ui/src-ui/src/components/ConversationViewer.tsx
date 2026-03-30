import { useConversationQuery } from "@/api";
import type { ConversationMessage } from "@/types";
import { cn } from "@/lib/utils";

interface ConversationViewerProps {
  identifier: string;
  initialCursor?: string;
}

function MessageBubble({ msg }: { msg: ConversationMessage }) {
  if (msg.role === "system") {
    return (
      <div className="rounded-lg p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800">
        <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-300 mb-1">
          <span className="font-medium">System</span>
          <span className="text-green-500 dark:text-green-400">Turn {msg.turn}</span>
        </div>
        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
      </div>
    );
  }

  if (msg.role === "assistant") {
    return (
      <div className={cn("rounded-lg p-3 border bg-card")}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <span className="font-medium">Assistant</span>
          <span>Turn {msg.turn}</span>
          <span className="text-muted-foreground/70">
            {msg.tokens.input}&darr; {msg.tokens.output}&uarr;
          </span>
        </div>
        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
      </div>
    );
  }

  // tool_call
  return (
    <div className="rounded-lg p-3 bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800">
      <div className="flex items-center gap-2 text-xs text-purple-700 dark:text-purple-300 mb-1">
        <span className="font-medium">{msg.tool_name}</span>
        <span>Turn {msg.turn}</span>
        {msg.status && (
          <span className={msg.status === "success" ? "text-green-600" : "text-red-600"}>
            {msg.status}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{msg.tool_input_summary}</p>
      {msg.tool_result_summary && (
        <details className="mt-2">
          <summary className="text-xs text-purple-600 dark:text-purple-400 cursor-pointer hover:underline">
            Result ({msg.tool_result_lines ?? 0} lines)
          </summary>
          <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {msg.tool_result_summary}
          </pre>
        </details>
      )}
    </div>
  );
}

export default function ConversationViewer({ identifier, initialCursor }: ConversationViewerProps) {
  const { data, isLoading, isError } = useConversationQuery(identifier, initialCursor);

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
        <MessageBubble key={msg.index} msg={msg} />
      ))}

      {(data.pagination.prev_cursor || data.pagination.next_cursor) && (
        <div className="flex justify-between items-center pt-4 border-t">
          <span className="text-xs text-muted-foreground">
            {data.pagination.has_more ? "More messages available" : "End of conversation"}
          </span>
        </div>
      )}
    </div>
  );
}
