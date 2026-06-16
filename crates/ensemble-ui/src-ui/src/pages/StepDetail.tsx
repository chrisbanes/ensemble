import { useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useStepDetailQuery } from "@/hooks";
import { Card, CardContent } from "@/components/ui/card";
import StatusBadge from "@/components/StatusBadge";
import EventTimeline from "@/components/EventTimeline";
import ConversationViewer from "@/components/ConversationViewer";
import { timelineRecordToEventData } from "@/ws-events";

export default function StepDetail() {
  const { identifier = "", stepName = "" } = useParams<{
    identifier: string;
    stepName: string;
  }>();
  const { data, isLoading, isError, error } = useStepDetailQuery(identifier, stepName);

  const events = useMemo(
    () => (data?.recent_events ?? []).map(timelineRecordToEventData),
    [data?.recent_events],
  );

  if (isLoading) {
    return <div className="text-center py-12 text-muted-foreground">Loading...</div>;
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          Failed to load step: {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to={`/issue/${encodeURIComponent(identifier)}`} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-bold">{data.step_name}</h1>
        <StatusBadge status={data.status} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Agent</dt>
            <dd className="mt-1 text-2xl font-semibold">{data.agent}</dd>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Status</dt>
            <dd className="mt-1 text-2xl font-semibold capitalize">{data.status}</dd>
          </CardContent>
        </Card>
        {data.verdict && (
          <Card>
            <CardContent className="p-4">
              <dt className="text-sm font-medium text-muted-foreground">Verdict</dt>
              <dd className="mt-1 text-2xl font-semibold">{data.verdict}</dd>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="p-4">
            <dt className="text-sm font-medium text-muted-foreground">Dependencies</dt>
            <dd className="mt-1 text-lg font-semibold">
              {data.dependencies.length > 0 ? data.dependencies.join(", ") : "\u2014"}
            </dd>
          </CardContent>
        </Card>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Recent Events</h2>
        <Card className="p-4 max-h-[600px] overflow-y-auto">
          <EventTimeline events={events} live={false} />
        </Card>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Transcript</h2>
        <Card className="p-4">
          {data.run_id && data.transcript ? (
            <ConversationViewer
              identifier={identifier}
              runId={data.run_id}
              stepName={data.step_name}
            />
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No transcript recorded for this step yet.
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
