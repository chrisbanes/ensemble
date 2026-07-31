import { FetchError } from "@/fetch-client";
import { AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const DEFAULT_MESSAGE = "Configuration was saved. Restart Ensemble to apply it.";

export function restartRequiredMessage(error: unknown): string | null {
  if (!(error instanceof FetchError) || error.status !== 409) {
    return null;
  }

  return error.message.startsWith("HTTP ") ? DEFAULT_MESSAGE : error.message;
}

export default function RestartRequiredNotice({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-900/30">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            <h2 className="text-lg font-semibold text-yellow-800 dark:text-yellow-200">
              Restart Required
            </h2>
          </div>
          <p className="mt-2 text-sm text-yellow-700 dark:text-yellow-300">
            Configuration was saved but cannot be activated by the running process.
          </p>
          <p className="mt-2 text-sm text-yellow-700 dark:text-yellow-300">{message}</p>
        </div>
      </CardContent>
    </Card>
  );
}
