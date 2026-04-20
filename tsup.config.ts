import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  dts: false,
  outDir: "dist",
  target: "node18",
  sourcemap: true,
  clean: true,
  splitting: false,
});
