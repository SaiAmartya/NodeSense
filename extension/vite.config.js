import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  // CRITICAL: relative base so assets resolve inside dist/ in the extension
  base: './',
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
});
