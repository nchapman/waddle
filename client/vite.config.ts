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
    // Discovered at RUNTIME by @tinfoilsh/verifier's dynamic sigstore
    // import — without pre-bundling, the late discovery re-optimizes
    // mid-session and 504s the verifier's module URLs ("Outdated Optimize
    // Dep" — caught by the live smoke; broke attestation with a generic
    // "Sigstore code bundle verification failed").
    include: ["@freedomofpress/sigstore-browser", "@tinfoilsh/verifier"],
  },
  resolve: {
    alias: {
      // Hot-loop linking: consume sdk source directly (no dist needed in dev).
      "@waddle/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // The enclave's Chromium reaches this dev server as host.docker.internal
    // (test pages under public/test) — allow the Host header through.
    allowedHosts: ["host.docker.internal"],
    proxy: {
      "/health": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
