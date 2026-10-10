import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronsUpDown, Gauge, LogOut, Settings } from "lucide-react";

/** Sessions carry no operator name (SPEC: one operator), so the account is labelled by its role. */
export const OPERATOR_LABEL = "Operator";

const menuItems = (menu: HTMLElement | null) =>
  Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

/**
 * Sidebar account menu: a WAI-ARIA menu button above the footer. Settings and Runtime are links;
 * Sign out is a button that keeps the menu open while it is pending.
 */
export function AccountMenu({
  path,
  navigate,
  pending,
  onSignOut,
}: {
  path: string;
  navigate: (path: string) => void;
  pending: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Which item to focus when the menu opens from the keyboard.
  const [focusOnOpen, setFocusOnOpen] = useState<"first" | "last" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const menuId = useId();
  const pathname = path.split(/[?#]/)[0];
  const items = () => menuItems(menu.current);

  useEffect(() => {
    if (!open || !focusOnOpen) return;
    const list = menuItems(menu.current);
    (focusOnOpen === "first" ? list[0] : list.at(-1))?.focus();
    setFocusOnOpen(null);
  }, [open, focusOnOpen]);

  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", press);
    return () => document.removeEventListener("pointerdown", press);
  }, [open]);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  };
  const openWith = (target: "first" | "last") => {
    setFocusOnOpen(target);
    setOpen(true);
  };
  const onTriggerKey = (event: KeyboardEvent) => {
    // A pointer-opened menu keeps focus on the trigger; Tab leaves it, so close it.
    if (event.key === "Tab") setOpen(false);
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      openWith("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openWith("last");
    }
  };
  const onMenuKey = (event: KeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === " " && list[index] instanceof HTMLAnchorElement) {
      // Space activates links too; buttons already do natively.
      event.preventDefault();
      list[index].click();
    } else if (event.key === "Tab") {
      // Close the menu and let native traversal continue from the trigger, in either direction.
      close(true);
    }
  };
  const link = (href: string, icon: ReactNode, label: string) => (
    <a
      role="menuitem"
      tabIndex={-1}
      className="account-menu-item"
      href={href}
      aria-current={pathname === href ? "page" : undefined}
      onClick={(event) => {
        if (
          event.button === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          navigate(href);
        }
      }}
    >
      {icon}
      {label}
    </a>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from the pointer-opened menu is handled on the wrapper; the trigger and items are the interactive elements.
    <div
      ref={root}
      className="account-menu"
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={trigger}
        id={triggerId}
        type="button"
        className="account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onKeyDown={onTriggerKey}
        onClick={(event) => {
          // A keyboard click (Enter or Space) has detail 0 and moves focus into the menu.
          if (open) setOpen(false);
          else if (event.detail === 0) openWith("first");
          else setOpen(true);
        }}
      >
        <span className="account-avatar" aria-hidden="true">
          OP
        </span>
        <span className="account-name">
          {OPERATOR_LABEL}
          <span className="sr-only"> account</span>
        </span>
        <ChevronsUpDown aria-hidden="true" className="nav-icon" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className="account-popup"
          onKeyDown={onMenuKey}
        >
          <p role="presentation" className="account-menu-label metadata muted">
            Signed in as {OPERATOR_LABEL}
          </p>
          <hr />
          {link("/app/settings", <Settings aria-hidden="true" />, "Settings")}
          {link(
            "/app/settings/runtime",
            <Gauge aria-hidden="true" />,
            "Runtime",
          )}
          <hr />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="account-menu-item"
            aria-disabled={pending || undefined}
            onClick={() => {
              if (!pending) onSignOut();
            }}
          >
            <LogOut aria-hidden="true" />
            {pending ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
    </div>
  );
}
