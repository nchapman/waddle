import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Hot-loop linking: consume sdk source directly (no dist needed in dev).
      "@waddle/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/health": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
