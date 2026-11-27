import { defineConfig } from "vite";

export default defineConfig({
  base: "/",
  resolve: {
    alias: [{ find: /^three$/, replacement: "three/webgpu" }],
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
