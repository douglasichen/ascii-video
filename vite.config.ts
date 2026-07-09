import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "node:path";

// Multi-page build: index.html (served at /) + embed.html (served at /embed.html — every already-baked
// <iframe src=".../embed.html?id=..."> depends on that path surviving). Vercel auto-detects Vite
// (`vite build` -> dist/) and still runs api/*.py as Python serverless functions, so no vercel.json needed.
//
// `npm run dev` (vite) serves the static pages only. For the FULL local stack — incl. the Python
// /api/resolve + /api/save functions — run `vercel dev` instead (server.py is the older yt-dlp
// same-origin-download helper for `python3 server.py`).
export default defineConfig({
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        embed: resolve(__dirname, "embed.html"),
      },
    },
  },
  test: {
    // Spawned agents run in throwaway git worktrees under .claude/worktrees/, each a full checkout with
    // its own copy of tests/. Without this, `npm test` globs all of them — dozens of stale duplicate suites
    // that slow the run and can false-fail under CPU contention. Only ever run the real tests/ at the root.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
