import { defineConfig, devices } from "@playwright/test";

// These tests drive a real running stack (`npm run up` from the repo root) rather
// than mocks: most bugs in this project have lived at the seams between services -
// a response envelope the client didn't unwrap, a room owner locked out of their
// own room - which no single-service unit test can see.
export default defineConfig({
  testDir: "./tests",
  // Jobs run on shared GPU worker pools, so parallel test files would contend for
  // the same card and make timings meaningless.
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
