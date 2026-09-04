import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "/fireball/",
  build: {
    rollupOptions: {
      input: {
        background: resolve(projectRoot, "index.html"),
        button: resolve(projectRoot, "button.html"),
        target: resolve(projectRoot, "target.html"),
      },
    },
  },
});
