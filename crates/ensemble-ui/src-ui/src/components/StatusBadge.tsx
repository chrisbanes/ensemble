import { Badge } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";
import type { badgeVariants } from "@/components/ui/badge";

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

interface StatusBadgeProps {
  status: string;
}

const variantMap: Record<string, BadgeVariant> = {
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
