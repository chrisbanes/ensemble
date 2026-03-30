import { useConversationQuery } from "@/hooks";
import type { ConversationMessage } from "@/generated/models";
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
          <span className="text-green-500 dark:text-green-400">#{msg.index}</span>
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
          <span>#{msg.index}</span>
        </div>
        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        {msg.tool_calls != null && (
          <details className="mt-2">
            <summary className="text-xs text-purple-600 dark:text-purple-400 cursor-pointer hover:underline">
              Tool calls
            </summary>
            <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {typeof msg.tool_calls === "string" ? msg.tool_calls : JSON.stringify(msg.tool_calls, null, 2)}
            </pre>
          </details>
        )}
      </div>
    );
  }

  // tool / tool_call / other roles
  return (
    <div className="rounded-lg p-3 bg-purple-50 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-800">
      <div className="flex items-center gap-2 text-xs text-purple-700 dark:text-purple-300 mb-1">
        <span className="font-medium">{msg.role}</span>
        <span>#{msg.index}</span>
      </div>
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">{msg.content}</p>
      {msg.tool_output != null && (
        <details className="mt-2">
          <summary className="text-xs text-purple-600 dark:text-purple-400 cursor-pointer hover:underline">
            Tool output
          </summary>
          <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {typeof msg.tool_output === "string" ? msg.tool_output : JSON.stringify(msg.tool_output, null, 2)}
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

      {data.next_cursor != null && (
        <div className="flex justify-between items-center pt-4 border-t">
          <span className="text-xs text-muted-foreground">
            More messages available
          </span>
        </div>
      )}
    </div>
  );
}
