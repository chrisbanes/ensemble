import { defineConfig } from "vite";
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
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
