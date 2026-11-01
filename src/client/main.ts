// The page's entry: it only loads the app (app.ts). Lazily loaded code (the landing page, the code highlighter, crash
// recovery) shares modules with the app. With the app in the entry itself, Bun had those chunks import the entry by
// its bare name ("./main.js") while the page loads it versioned (main.js?v=…, main.<hash>.js on the static host), so
// the browser ran a second copy of the whole app, booting again: on the home page a second doodle and socket, drawing
// your own pencil twice. Now the app is a chunk of its own (content-hashed: one URL), so everything shares its one
// copy; chunks still import this file for Bun's small loader helper, and running it twice only asks for the same
// app chunk again (already loaded: nothing runs twice). index.html preloads the app chunk (writeBootPreload).

// The theme before anything renders (theme.ts owns it; inlined here so the entry imports nothing else).
try {
  const pref = localStorage.getItem("grimoire.theme.v1");
  const t = pref === "light" || pref === "dark" ? pref : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t;
} catch {}

void import("./app.ts");
