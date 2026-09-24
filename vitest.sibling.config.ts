import { defineConfig } from "vitest/config";

// npm run check:sibling            → tests YOUR sibling functions (red until you write them)
// SOLUTIONS=1 npm run check:sibling → tests the finished versions in solutions/
export default defineConfig({
  test: {
    include: ["test/siblings/**/*.test.ts"],
  },
});
