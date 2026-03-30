import { Badge, type BadgeProps } from "@/components/ui/badge";

interface StatusBadgeProps {
  status: string;
}

const variantMap: Record<string, BadgeProps["variant"]> = {
  running: "success",
  succeeded: "success",
  retrying: "warning",
  reviewing: "info",
  failed: "destructive",
  stopped: "secondary",
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const variant = variantMap[status] ?? "outline";
  return <Badge variant={variant}>{status}</Badge>;
}
