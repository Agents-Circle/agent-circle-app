"use client";

import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  // Before hydration `resolvedTheme` is undefined, so this renders the dark-state
  // toggle and matches the server output — a real control rather than an empty pill,
  // and no hydration mismatch.
  //
  // This used to track a `mounted` flag set from an effect. The flag was only ever a
  // proxy for "has next-themes resolved yet", which `resolvedTheme` answers by itself,
  // and setting state synchronously in an effect is what React 19 flags as a cascading
  // render. Same output, one less render pass.
  const isLight = resolvedTheme === "light";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isLight}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      title={isLight ? "Dark mode" : "Light mode"}
      onClick={() => setTheme(isLight ? "dark" : "light")}
      className="theme-toggle"
    >
      <span className="theme-toggle-track">
        <span className="theme-toggle-thumb" data-pos={isLight ? "right" : "left"} />
      </span>
    </button>
  );
}
