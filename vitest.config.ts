import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Meniru tsconfig "paths": { "@/*": ["./*"] }
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});