import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/ui",
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
