import { useEffect, useRef } from "react";
import { readinessCheckIds } from "../../src/operator/readiness.js";

/** The Settings index sections, in the designed order (frame 114), with their stable fragments. */
export const SETTINGS_SECTIONS = [
  { id: "projects", label: "Projects" },
  { id: "runtime", label: "Runtime & recovery" },
  { id: "profiles", label: "Profiles" },
  { id: "routing", label: "Routing" },
  { id: "github-discovery", label: "GitHub discovery" },
  { id: "cli-credentials", label: "CLI credentials" },
  { id: "notifications", label: "Notifications" },
  { id: "readiness", label: "Readiness" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/**
 * Section order for the page and its navigation. Until a task starts a turn Readiness
 * comes first (frame 114c); an unknown start state keeps the designed order.
 */
export function settingsSectionOrder(
  turnStarted: boolean | undefined,
): SettingsSectionId[] {
  const ids = SETTINGS_SECTIONS.map((s) => s.id);
  return turnStarted === false
    ? ["readiness", ...ids.filter((id) => id !== "readiness")]
    : ids;
}

export const settingsSectionHref = (id: SettingsSectionId) =>
  `/app/settings#${id}`;

/** Add Claude, the panel at the top of the Runtime page. */
export const addClaudeHref = "/app/settings/runtime#add-claude";

/** A Readiness check's own article, by its public check id. */
export const readinessCheckHref = (checkId: string) =>
  `/app/settings#readiness-${checkId}`;

/** A fragment as an element id, or null when it is empty or not decodable. */
function fragmentId(hash = location.hash) {
  try {
    return decodeURIComponent(hash.slice(1)) || null;
  } catch {
    return null;
  }
}

/**
 * The one answer to "does this page land on this fragment right now": the element a
 * fragment names on a Settings route, or null. The route decides which ids are targets
 * (a section or a check's own anchor on `/app/settings`, `add-claude` on the Runtime
 * page), and the element must be on the page, so a page that has not rendered its target
 * yet (reads or the workspace still loading, a failed readiness read) answers null.
 * `useFragmentLanding` lands on it and the shell's popstate restore skips scrolling
 * only for it, so the two cannot disagree.
 */
export function landingElement(
  pathname: string,
  hash: string,
): HTMLElement | null {
  const id = fragmentId(hash);
  if (!id) return null;
  const supported =
    pathname === "/app/settings"
      ? SETTINGS_SECTIONS.some((s) => s.id === id) ||
        readinessCheckIds.some((c) => `readiness-${c}` === id)
      : pathname === "/app/settings/runtime" && id === "add-claude";
  return supported ? document.getElementById(id) : null;
}

/**
 * The section the fragment names, or null (an unknown fragment names none). A check's own
 * anchor (`#readiness-<check id>`) names the Readiness section it sits in.
 */
export function fragmentSection(): SettingsSectionId | null {
  const id = fragmentId();
  if (
    id?.startsWith("readiness-") &&
    readinessCheckIds.some((c) => `readiness-${c}` === id)
  )
    return "readiness";
  return SETTINGS_SECTIONS.find((s) => s.id === id)?.id ?? null;
}

/** How long a landing re-asserts itself while the page above it settles. */
const SETTLE_MS = 3000;

/**
 * Scroll `target` into view and focus its heading. Reads above it can still be growing
 * (Safari has no scroll anchoring), so a layout change re-scrolls until the first user
 * input, a focus move elsewhere, or `SETTLE_MS`.
 */
function land(target: HTMLElement) {
  target.scrollIntoView();
  const heading = target.querySelector<HTMLElement>("h2,h3");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  const settle = new ResizeObserver(() => {
    const active = document.activeElement;
    if (target.isConnected && (active === document.body || active === heading))
      target.scrollIntoView();
  });
  settle.observe(document.body);
  // Chromium clears focus after a browser-made hash change lands, so give it back.
  const refocus = () => {
    if (
      document.activeElement === document.body &&
      landingElement(location.pathname, location.hash) === target
    )
      heading?.focus({ preventScroll: true });
  };
  addEventListener("hashchange", refocus);
  const events = ["wheel", "touchstart", "pointerdown", "keydown", "pagehide"];
  const stop = () => {
    clearTimeout(timer);
    settle.disconnect();
    removeEventListener("hashchange", refocus);
    for (const e of events) removeEventListener(e, stop);
  };
  const timer = setTimeout(stop, SETTLE_MS);
  for (const e of events) addEventListener(e, stop, { passive: true });
  return stop;
}

/** The landing that was last done; every hook of a page shares it. */
let landedIdentity: string | null = null;

/**
 * What a page does for the entry it is now on. The shell guarantees that a saved scroll
 * position in the state belongs to the entry itself (it starts any entry reached by a
 * fragment change from clean state), so it is a restoration to keep; otherwise the page
 * lands on its fragment target, or the shell restores the top.
 */
export type LandingDecision =
  | { action: "restore"; y: number }
  | { action: "land"; target: HTMLElement }
  | { action: "top" };

export function landingDecision(
  state: { scrollY?: number } | null,
  pathname: string,
  hash: string,
): LandingDecision {
  if (typeof state?.scrollY === "number")
    return { action: "restore", y: state.scrollY };
  const target = landingElement(pathname, hash);
  return target ? { action: "land", target } : { action: "top" };
}

/**
 * A landing is a history entry and the fragment it names, not the entry alone: the entry
 * key can stay while the fragment changes.
 */
const landingIdentity = () =>
  `${(history.state as { navKey?: string } | null)?.navKey ?? ""}|${location.pathname}${location.hash}`;

/**
 * Land where `landingDecision` says, once per landing identity (a restoration also counts
 * as done, so a target drawn later does not land on a restored entry). `ready` holds the
 * landing until the page can no longer reorder or grow its target. Several hooks on one
 * page may call this: the first whose target is on the page lands, and a target that
 * appears later (a check's article after its read) is landed on by whichever hook sees it.
 * The identity is read on every render, the shell re-renders on each popstate, and a
 * changed identity ends the previous landing (its settle observer and refocus) before the
 * next begins.
 */
export function useFragmentLanding(ready: boolean) {
  const identity = landingIdentity();
  const landedHere = useRef(false);
  // Leaving the page forgets its landing, so coming back to the same entry lands again.
  useEffect(
    () => () => {
      if (landedHere.current) landedIdentity = null;
    },
    [],
  );
  useEffect(() => {
    if (!ready || landedIdentity === identity) return;
    const decision = landingDecision(
      history.state,
      location.pathname,
      location.hash,
    );
    // Nothing to land on here: forget an earlier landing, so coming back to its entry
    // (Forward after Back through this one) lands again.
    if (decision.action === "top") {
      landedIdentity = null;
      return;
    }
    landedIdentity = identity;
    landedHere.current = true;
    if (decision.action === "land") return land(decision.target);
  }, [identity, ready]);
}
