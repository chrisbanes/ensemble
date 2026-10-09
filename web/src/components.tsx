import {
  forwardRef,
  useRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type { ResourceState } from "./resource.js";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Menu } from "lucide-react";
import { cn } from "./lib/utils.js";
import { Alert, AlertDescription } from "./ui/alert.js";
import { Badge } from "./ui/badge.js";
import { Button as PrimitiveButton } from "./ui/button.js";
import { Input } from "./ui/input.js";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet.js";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary";
  }
>(function Button({ children, variant = "primary", className, ...props }, ref) {
  return (
    <PrimitiveButton
      ref={ref}
      variant={variant === "primary" ? "default" : "outline"}
      className={cn("control", className)}
      {...props}
    >
      {children}
    </PrimitiveButton>
  );
});

export function ActionLink({
  children,
  variant = "primary",
  className,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary";
}) {
  return (
    <PrimitiveButton
      asChild
      variant={variant === "primary" ? "default" : "outline"}
      className={cn("control", className)}
    >
      <a {...props}>{children}</a>
    </PrimitiveButton>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }
>(function TextField({ label, id, className, ...props }, ref) {
  return (
    <label className="field body" htmlFor={id}>
      {label}
      <Input ref={ref} {...props} id={id} className={className} />
    </label>
  );
});

export function StatusBadge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "error" | "success";
  className?: string;
}) {
  const variant =
    tone === "error"
      ? "destructive"
      : tone === "warning"
        ? "outline"
        : "secondary";
  return (
    <Badge variant={variant} className={cn("metadata", className)}>
      {children}
    </Badge>
  );
}

export function ResourceStatus<T>({
  state,
  retry,
  label = "Projects",
}: {
  state: ResourceState<T>;
  retry: () => void;
  label?: string;
}) {
  if (state.status === "fresh") return null;
  const message =
    state.error === "not-found"
      ? `${label} not found.`
      : state.status === "loading"
        ? `Loading ${label.toLowerCase()}…`
        : state.status === "stale"
          ? state.error
            ? "Refresh failed. Showing the last fetched data."
            : "Refreshing. Showing the last fetched data."
          : state.status === "error"
            ? `${label} are unavailable. Try again.`
            : "No data loaded.";
  return (
    <Alert
      className={cn("resource-status", state.error && "resource-status-error")}
      variant={state.error ? "destructive" : "default"}
      role={state.error ? "alert" : "status"}
    >
      <AlertDescription>
        <p className="body">{message}</p>
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
      </AlertDescription>
    </Alert>
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
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <PrimitiveButton
          ref={trigger}
          variant="ghost"
          size="icon"
          className="control"
        >
          <Menu aria-hidden="true" />
          <span className="sr-only">Projects and navigation</span>
        </PrimitiveButton>
      </SheetTrigger>
      <SheetContent
        className="drawer"
        onCloseAutoFocus={(event) => {
          if (trigger.current) {
            event.preventDefault();
            trigger.current.focus();
          }
        }}
      >
        <SheetHeader>
          <SheetTitle className="section-heading">
            Projects and navigation
          </SheetTitle>
          <SheetDescription className="body muted">
            Choose a project or operator destination.
          </SheetDescription>
        </SheetHeader>
        <SheetClose asChild>
          <Button variant="secondary">Close navigation</Button>
        </SheetClose>
        <Dialog.Close asChild>
          <div className="drawer-body">{children}</div>
        </Dialog.Close>
      </SheetContent>
    </Sheet>
  );
}

/** Content of a link that only opens another view: title, optional summary and a chevron. */
export function NavigationRow({
  icon,
  title,
  summary,
  trailing,
}: {
  icon?: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <>
      {icon}
      <span className="nav-label">
        <span>{title}</span>
        {summary && <span className="metadata muted">{summary}</span>}
      </span>
      {trailing}
      <ChevronRight aria-hidden="true" className="nav-chevron" />
    </>
  );
}

/**
 * The one title (h1) of a route. Desktop shows title, optional subtitle and one action.
 * At phone widths a top-level route adds the menu button and a count; a nested route
 * adds a Back link to its static parent instead.
 */
export function PageHeader({
  title,
  subtitle,
  action,
  badge,
  menu,
  back,
}: {
  title: string;
  subtitle?: string | undefined;
  action?: ReactNode;
  badge?: string | undefined;
  menu?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header
      className="page-header"
      data-variant={back ? "detail" : "top-level"}
    >
      {menu && <div className="phone-nav">{menu}</div>}
      {back && (
        <PrimitiveButton
          asChild
          variant="ghost"
          className="control page-header-back"
        >
          <a href={back.href} aria-label={`Back to ${back.label}`}>
            <ChevronLeft aria-hidden="true" />
            <span>{back.label}</span>
          </a>
        </PrimitiveButton>
      )}
      <div className="page-header-title">
        <h1 className="page-heading">{title}</h1>
        {subtitle && <p className="introduction muted">{subtitle}</p>}
      </div>
      {badge && (
        <StatusBadge className="page-header-count">{badge}</StatusBadge>
      )}
      {action}
    </header>
  );
}
