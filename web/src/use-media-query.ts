import { useEffect, useState } from "react";

/** Tracks a media query; false where `matchMedia` is unavailable. */
export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(
    () => typeof matchMedia === "function" && matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const list = matchMedia(query),
      update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}
