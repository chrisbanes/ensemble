import { useState, useEffect, useCallback } from "react";
import { Dialog } from "@base-ui/react";
import { Button } from "@/components/ui/button";

interface FsEntry {
  name: string;
  is_dir: boolean;
  path: string;
}

interface FsListResponse {
  entries: FsEntry[];
  truncated: boolean;
}

interface FileBrowserProps {
  mode: "file" | "directory";
  onSelect: (path: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  initialPath?: string;
}

type FetchState = "idle" | "loading" | "error";

function getBreadcrumbSegments(currentPath: string): { label: string; path: string }[] {
  if (currentPath === "/") return [{ label: "/", path: "/" }];
  const segments = currentPath.split("/").filter(Boolean);
  const breadcrumbs: { label: string; path: string }[] = [{ label: "/", path: "/" }];
  let accumulated = "";
  for (const segment of segments) {
    accumulated += `/${segment}`;
    breadcrumbs.push({ label: segment, path: accumulated });
  }
  return breadcrumbs;
}

export default function FileBrowser({
  mode,
  onSelect,
  open,
  onOpenChange,
  title,
  initialPath,
}: FileBrowserProps) {
  const defaultPath = initialPath || "/";
  const [currentPath, setCurrentPath] = useState(defaultPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const fetchDirectory = useCallback(async (path: string) => {
    setFetchState("loading");
    setErrorMessage(null);
    setSelectedPath(null);
    try {
      const res = await fetch(`/api/v1/fs/list?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null) as Record<string, unknown> | null;
        const errorMessage =
          body &&
          typeof body.error === "object" &&
          body.error !== null &&
          typeof (body.error as Record<string, string>).message === "string"
            ? (body.error as Record<string, string>).message
            : `HTTP ${res.status}`;
        setErrorMessage(errorMessage ?? `HTTP ${res.status}`);
        setFetchState("error");
        setEntries([]);
        return;
      }
      const data: FsListResponse = await res.json();
      setEntries(data.entries);
      setTruncated(data.truncated);
      setFetchState("idle");
    } catch {
      setErrorMessage("Failed to fetch directory contents");
      setFetchState("error");
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setCurrentPath(defaultPath);
      setSelectedPath(null);
      setEntries([]);
      fetchDirectory(defaultPath);
    }
  }, [open, fetchDirectory, defaultPath]);

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
    fetchDirectory(path);
  };

  const handleDoubleClick = (entry: FsEntry) => {
    if (entry.is_dir) {
      handleNavigate(entry.path);
    }
  };

  const handleClick = (entry: FsEntry) => {
    if (mode === "file" && !entry.is_dir) {
      setSelectedPath(entry.path);
    } else if (mode === "directory" && entry.is_dir) {
      setSelectedPath(entry.path);
    }
  };

  const handleSelect = () => {
    if (selectedPath) {
      onSelect(selectedPath);
      onOpenChange(false);
    }
  };

  const breadcrumbSegments = getBreadcrumbSegments(currentPath);

  const displayEntries = mode === "directory"
    ? (entries ?? []).filter((e) => e.is_dir)
    : entries ?? [];

  const dialogTitle = title || (mode === "file" ? "Select a File" : "Select a Directory");

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(isOpen: boolean) => onOpenChange(isOpen)}
      modal
    >
      <Dialog.Backdrop className="fixed inset-0 bg-black/50 z-40" />
      <Dialog.Portal>
        <Dialog.Popup
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border rounded-lg shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col"
        >
          <div className="p-4 border-b">
            <Dialog.Title className="text-lg font-medium">
              {dialogTitle}
            </Dialog.Title>
          </div>

          {/* Breadcrumb */}
          <div className="px-4 py-2 border-b flex items-center gap-1 text-sm overflow-x-auto">
            {breadcrumbSegments.map((segment, index) => (
              <span key={segment.path} className="flex items-center gap-1">
                {index > 0 && <span className="text-muted-foreground">/</span>}
                <button
                  type="button"
                  className="text-primary hover:underline cursor-pointer disabled:opacity-50"
                  onClick={() => handleNavigate(segment.path)}
                  disabled={segment.path === currentPath}
                >
                  {segment.label}
                </button>
              </span>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-2 min-h-0">
            {fetchState === "loading" && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                Loading...
              </div>
            )}

            {fetchState === "error" && (
              <div className="flex items-center justify-center py-8 text-destructive">
                {errorMessage || "An error occurred"}
              </div>
            )}

            {fetchState === "idle" && displayEntries.length === 0 && (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                This directory is empty
              </div>
            )}

            {fetchState === "idle" && displayEntries.length > 0 && (
              <ul className="space-y-0.5">
                {displayEntries.map((entry) => {
                  const isSelected = selectedPath === entry.path;
                  const isSelectable =
                    (mode === "file" && !entry.is_dir) ||
                    (mode === "directory" && entry.is_dir);

                  return (
                    <li
                      key={entry.path}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded cursor-pointer text-sm ${
                        isSelected
                          ? "bg-primary/10 text-primary"
                          : isSelectable
                            ? "hover:bg-muted"
                            : "text-muted-foreground cursor-default"
                      }`}
                      onClick={() => handleClick(entry)}
                      onDoubleClick={() => handleDoubleClick(entry)}
                    >
                      <span className="shrink-0">
                        {entry.is_dir ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}
                      </span>
                      <span className="truncate">{entry.name}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            {truncated && (
              <div className="text-xs text-muted-foreground mt-2 px-3">
                Results truncated
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t flex justify-end gap-2">
            <Dialog.Close render={<Button variant="outline" />}>
              Cancel
            </Dialog.Close>
            <Button onClick={handleSelect} disabled={!selectedPath}>
              Select
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
