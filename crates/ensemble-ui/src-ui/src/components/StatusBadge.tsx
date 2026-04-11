import { Badge } from "@/components/ui/badge";
import type { badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

interface StatusBadgeProps {
  status: string;
}

const variantMap: Record<string, BadgeVariant> = {
  running: "default",
  succeeded: "default",
  retrying: "secondary",
  reviewing: "secondary",
  failed: "destructive",
  stopped: "outline",
  completed_succeeded: "default",
  completed_failed: "destructive",
  completed_stopped: "outline",
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const variant = variantMap[status] ?? "outline";
  return <Badge variant={variant}>{status}</Badge>;
}
