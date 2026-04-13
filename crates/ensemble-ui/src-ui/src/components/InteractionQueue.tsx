import { Link } from "react-router-dom";
import type { WaitingInteractionRow } from "@/generated/models";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface InteractionQueueProps {
  interactions: WaitingInteractionRow[];
}

function formatAge(requestedAt: string): string {
  const ms = Date.now() - new Date(requestedAt).getTime();
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function InteractionQueue({ interactions }: InteractionQueueProps) {
  if (interactions.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No issues need input.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issue</TableHead>
          <TableHead>Step</TableHead>
          <TableHead>Age</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {interactions.map((interaction) => (
          <TableRow key={interaction.interaction_request_id}>
            <TableCell>
              <Link
                to={`/issue/${encodeURIComponent(interaction.issue_identifier)}`}
                className="text-primary hover:underline font-medium"
              >
                {interaction.issue_identifier}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">
              <div>
                <p className="font-medium">{interaction.step_name}</p>
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatAge(interaction.requested_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
