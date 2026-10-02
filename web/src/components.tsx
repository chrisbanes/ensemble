import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { ResourceState } from "./resource.js";
export function Button({
  children,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
}) {
  return (
    <button {...props} className={`control button ${variant}`}>
      {children}
    </button>
  );
}
export function TextField({
  label,
  id,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return (
    <label className="field body" htmlFor={id}>
      {label}
      <input {...props} id={id} className="control" />
    </label>
  );
}
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "error" | "success";
}) {
  return <span className={`badge metadata ${tone}`}>{children}</span>;
}
export function ResourceStatus<T>({
  state,
  retry,
}: {
  state: ResourceState<T>;
  retry: () => void;
}) {
  if (state.status === "fresh")
    return (
      <p className="metadata muted">
        Fetched{" "}
        {state.fetchedAt ? new Date(state.fetchedAt).toLocaleTimeString() : ""}
      </p>
    );
  return (
    <div
      className={`resource-status ${state.error ? "error" : "neutral"}`}
      role={state.error ? "alert" : "status"}
    >
      <p className="body">
        {state.status === "loading"
          ? "Loading projects…"
          : state.status === "stale"
            ? state.error
              ? "Refresh failed. Showing the last fetched data."
              : "Refreshing. Showing the last fetched data."
            : state.status === "error"
              ? "Projects are unavailable. Try again."
              : "No data loaded."}
      </p>
      {state.fetchedAt && (
        <p className="metadata">
          Last fetched {new Date(state.fetchedAt).toLocaleTimeString()}
        </p>
      )}
      {state.error && (
        <Button variant="secondary" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function MobileNavigation({
  children,
  open,
  onOpenChange,
}: {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>
        <Button variant="secondary">Projects and navigation</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="drawer-overlay" />
        <Dialog.Content className="drawer">
          <Dialog.Title className="section-heading">
            Projects and navigation
          </Dialog.Title>
          <Dialog.Description className="body muted">
            Choose a project or operator destination.
          </Dialog.Description>
          <Dialog.Close asChild>
            <Button variant="secondary">Close navigation</Button>
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
