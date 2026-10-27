import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests send a few hundred real requests to DynamoDB Local.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
