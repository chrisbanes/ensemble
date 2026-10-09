import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [tailwindcss()],
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  publicDir: false,
  build: {
    outDir: "../dist/operator",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
    assetsDir: "assets",
    // ponytail: the operator UI is served locally; code-split routes if the main chunk passes 1 MB.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      // React Server Component "use client" directives are irrelevant to this client-only bundle.
      checks: { moduleLevelDirective: false },
    },
  },
});
