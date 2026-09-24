import { defineConfig } from "vitest/config";

// The default suite: always green on a fresh clone. The "write the sibling" exercises have their own
// suite (vitest.sibling.config.ts), so an unfinished exercise never turns `npm test` red.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/siblings/**", "node_modules/**"],
  },
});
