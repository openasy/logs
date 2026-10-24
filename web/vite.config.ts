import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { colophon } from "@openasy/ui/vite";
import { defineConfig } from "vite";

// The VictoriaLogs the image carries, as scripts/victorialogs.ts pins it.
const victoriaLogs = /VERSION = "v([^"]+)"/.exec(readFileSync(new URL("../scripts/victorialogs.ts", import.meta.url), "utf8"))?.[1];

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    colophon({
      roles: { yaml: "Reading the hosts file" },
      extra: [
        {
          name: "VictoriaLogs",
          version: victoriaLogs,
          license: "Apache-2.0",
          url: "https://docs.victoriametrics.com/victorialogs/",
          role: "Stores and searches the logs",
        },
      ],
    }),
  ],
  build: { outDir: "../dist/web", emptyOutDir: true },
  // The API only takes cookie requests from its own origin, so the dev server presents itself as that origin.
  server: { proxy: { "/api": { target: "http://localhost:8080", headers: { origin: "http://localhost:8080" } } } },
});
