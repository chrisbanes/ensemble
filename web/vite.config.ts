import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  publicDir: false,
  build: {
    outDir: "../dist/operator",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
    assetsDir: "assets",
  },
});
