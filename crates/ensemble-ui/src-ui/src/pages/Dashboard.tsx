import { useStateQuery, useRefreshMutation } from "@/hooks";
import { Button } from "@/components/ui/button";
import KanbanBoard from "@/components/KanbanBoard";
import InteractionQueue from "@/components/InteractionQueue";

export default function Dashboard() {
  const { data, isLoading, isError, error } = useStateQuery();
  const refreshMutation = useRefreshMutation();

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          Failed to load state: {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (!data) return null;

  const waitingInteractions = data.waiting_on_human ?? [];
  const kanbanData = {
    ...data,
    waiting_on_human: waitingInteractions.length > 0 ? [] : data.waiting_on_human,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Control Room</h1>
        <Button
          onClick={() => refreshMutation.mutate()}
          disabled={refreshMutation.isPending}
        >
          {refreshMutation.isPending ? "Refreshing..." : "Refresh"}
        </Button>
      </div>

      {waitingInteractions.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">Needs attention</h2>
          <InteractionQueue interactions={waitingInteractions} />
        </section>
      )}

      <KanbanBoard data={kanbanData} />
    </div>
  );
}
