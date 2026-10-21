import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { stubs } from "./dev/stub.ts";

/** The follow-me server `npm run ui:dev` talks to: `FOLLOW_ME_URL=http://127.0.0.1:<port>`. */
const target = process.env["FOLLOW_ME_URL"] ?? "http://127.0.0.1:4760";
// The server only answers its own origin, so the proxy speaks as it.
const proxy = {
  target,
  changeOrigin: true,
  headers: { origin: target },
};

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "follow-me-stubs",
      configureServer: (server) => void server.middlewares.use(stubs(target)),
    },
  ],
  server: { proxy: { "/api": proxy, "^/s/[^/]+/api/": proxy } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "logic", include: ["src/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "page",
          include: ["src/**/*.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            // The installed Chrome, so neither a developer nor CI downloads a browser build.
            provider: playwright({ launchOptions: { channel: "chrome" } }),
            instances: [{ browser: "chromium", viewport: { width: 1280, height: 900 } }],
          },
        },
      },
    ],
  },
});
