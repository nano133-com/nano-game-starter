import { defineConfig } from "vitest/config";

// The tests cover what must never break: money (amounts, reservation, payment match, node failover),
// records (exactly once) and sign-in (signatures, the admin guard). No real network and no real money.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
    maxWorkers: 2,
  },
});
