import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ErrorEntryProps {
  message: string;
  isActive: boolean;
}

export function ErrorEntry({ message, isActive }: ErrorEntryProps) {
  return (
    <Card className={cn("border-red-300/70 bg-red-50/50 p-4", isActive && "ring-2 ring-primary")}>
      <div className="text-xs font-medium uppercase text-red-700">Error</div>
      <div className="mt-1 text-sm whitespace-pre-wrap text-red-900">{message}</div>
    </Card>
  );
}
