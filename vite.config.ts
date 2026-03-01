import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/ui",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/ui"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3100",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
});
