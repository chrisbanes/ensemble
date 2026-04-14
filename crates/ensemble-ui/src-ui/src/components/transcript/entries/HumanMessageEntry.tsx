import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface HumanMessageEntryProps {
  message: string;
  isActive: boolean;
}

export function HumanMessageEntry({ message, isActive }: HumanMessageEntryProps) {
  return (
    <Card className={cn("border-emerald-300/60 bg-emerald-50/40 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-emerald-700">Human message</div>
      <div className="mt-1 text-sm whitespace-pre-wrap">{message}</div>
    </Card>
  );
}
