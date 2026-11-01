// Light or dark: the account menu's Theme (System, Light, Dark), kept per browser. <html data-theme> always holds the
// resolved theme ("light" | "dark"), so the CSS has one dark rule set (app.css, editor.css: `:root[data-theme="dark"]`).
// main.ts applies it before the app renders (the CSP allows no inline script, so the splash follows the system).

export type ThemePref = "system" | "light" | "dark";

/** localStorage key (main.ts reads the same key, without importing this module). */
export const THEME_KEY = "grimoire.theme.v1";

const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolvedTheme(pref = themePref()): "light" | "dark" {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}

export function applyTheme(): void {
  const t = resolvedTheme();
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", t);
}

export function setThemePref(p: ThemePref): void {
  try {
    if (p === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch {}
  applyTheme();
}

/** Follow the system while the preference is System (also across tabs: another tab changed it). */
export function watchTheme(): void {
  media?.addEventListener("change", () => {
    if (themePref() === "system") applyTheme();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY) applyTheme();
  });
}
