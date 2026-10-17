import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 3000,
    host: "127.0.0.1",
    strictPort: true,
    // Pre-transform the entry graph while the dev server boots so the first
    // page load doesn't pay for cold module transforms.
    warmup: {
      clientFiles: ["./src/main.tsx", "./src/App.tsx"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // Skip the per-chunk gzip sizing pass — it only feeds build logs and
    // costs noticeable time on large bundles.
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
          "vendor-editor": ["@monaco-editor/react"],
          "vendor-terminal": [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-web-links",
          ],
          "vendor-markdown": [
            "react-markdown",
            "remark-gfm",
            "rehype-highlight",
          ],
          "vendor-ui": ["lucide-react", "react-resizable-panels"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
