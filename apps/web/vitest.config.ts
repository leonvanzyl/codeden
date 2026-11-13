import { resolve } from "node:path";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    // Rendering and typing through jsdom slows down a lot on a busy machine.
    testTimeout: 15_000,
  },
});
