import { ActionLink } from "./components.js";

export const notFoundSubtitle =
  "This address doesn't match an Ensemble page. Nothing was changed.";

/** Body of the "Page not found" route; the title and subtitle live in the page header. */
export function NotFound() {
  return <ActionLink href="/app">Go to Overview</ActionLink>;
}
