import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(projectRoot, "index.html"),
        microsoftRedirect: resolve(projectRoot, "redirect.html")
      }
    }
  },
  server: {
    host: "localhost",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8788"
    }
  }
});
