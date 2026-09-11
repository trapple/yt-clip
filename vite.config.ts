import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.config";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: { "@": src },
  },
});
