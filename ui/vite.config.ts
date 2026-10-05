import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the built bundle also works inside the Tauri webview (file://).
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5179,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5178",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    // Optional renderers (Mermaid, KaTeX) are fetched from a CDN at runtime so
    // the app stays offline-capable; leave the dynamic import in place.
    rollupOptions: {
      external: [/^https:\/\//],
    },
  },
});
