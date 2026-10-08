import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), wasm(), tailwindcss()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  optimizeDeps: {
    // The betterbase SDK links as TypeScript source; pre-bundling would
    // rebuild the wasm imports and break worker loading.
    exclude: ["betterbase"],
  },
  resolve: {
    alias: {
      // Hot-loop linking: consume sdk source directly (no dist needed in dev).
      "@waddle/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/health": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
