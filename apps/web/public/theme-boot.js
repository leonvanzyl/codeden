// Applies the saved theme before the first paint, so it never flashes (see lib/theme/resolve.ts,
// which writes `codeden.theme.boot`). A plain script, not a module: it must run before the page
// renders, and the UI's Content-Security-Policy allows no inline scripts.
(() => {
  const root = document.documentElement;
  try {
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    const boot = JSON.parse(localStorage.getItem("codeden.theme.boot") || "null");
    // Before the first save of a theme: the mode this browser kept, if any.
    const kept = JSON.parse(localStorage.getItem("codeden.theme") || "null");
    const mode = boot?.mode ?? kept?.state?.preference ?? "dark";
    const kind =
      mode === "system" ? (light ? "light" : "dark") : mode === "light" ? "light" : "dark";
    root.classList.toggle("dark", kind === "dark");
    const slot = boot?.[kind];
    if (!slot?.vars || typeof slot.vars !== "object") return;
    for (const [name, value] of Object.entries(slot.vars)) {
      if (/^[a-z0-9-]+$/.test(name) && typeof value === "string") {
        root.style.setProperty(`--${name}`, value);
      }
    }
    if (typeof slot.theme === "string") root.setAttribute("data-theme", slot.theme);
  } catch {
    // Unreadable storage: the app applies the theme once it loads.
  }
})();
