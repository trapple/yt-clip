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
  build: {
    rollupOptions: {
      // offscreen document は manifest から参照されないため明示的に入力へ加える
      input: {
        offscreen: fileURLToPath(
          new URL("./src/offscreen/offscreen.html", import.meta.url),
        ),
      },
    },
  },
});
