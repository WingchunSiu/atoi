// Themes. The default is the dark Tensorlake-inspired theme; the others are opt-in:
//   (none) / ?theme=tensorlake  dark, Tensorlake-inspired (src/styles/theme-tensorlake.css)
//   ?theme=paper                the original sketch-based theme from the plan (tokens.css)
//   ?theme=scenic               cobalt-on-cream engraving (src/styles/theme-scenic.css)
import { useSyncExternalStore } from "react";

export type ThemeName = "tensorlake" | "paper" | "scenic";
export const THEMES: ThemeName[] = ["tensorlake", "paper", "scenic"];
export const DEFAULT_THEME: ThemeName = "tensorlake";

const listeners = new Set<() => void>();
let current: ThemeName = DEFAULT_THEME;

function fromUrl(): ThemeName {
  const t = new URLSearchParams(location.search).get("theme");
  return THEMES.find((x) => x === t) ?? DEFAULT_THEME;
}

function apply(theme: ThemeName) {
  current = theme;
  // tokens.css holds the paper tokens; every other theme overrides them under data-theme.
  if (theme === "paper") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const l of listeners) l();
}

/** Call once at startup, before the first render. */
export function initTheme() {
  apply(fromUrl());
}

/** Switch themes in place and keep the choice in the URL so it survives reloads and links. */
export function setTheme(theme: ThemeName) {
  const params = new URLSearchParams(location.search);
  if (theme === DEFAULT_THEME) params.delete("theme");
  else params.set("theme", theme);
  const qs = params.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
  apply(theme);
}

export function useTheme(): ThemeName {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
