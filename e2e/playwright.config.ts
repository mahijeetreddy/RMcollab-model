import { defineConfig, devices } from "@playwright/test";

// These tests drive a real running stack (`npm run up` from the repo root) rather
// than mocks: most bugs in this project have lived at the seams between services -
// a response envelope the client didn't unwrap, a room owner locked out of their
// own room - which no single-service unit test can see.
const BROWSER_SPECS = ["ui.spec.ts", "notes.spec.ts", "features.spec.ts", "ownership.spec.ts", "responsive.spec.ts"];

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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Firefox and Safari's engine, with CROSS_BROWSER=1 (`npm run test:browsers`):
    // the specs that exercise the browser itself - the editor, sockets, layout,
    // clipboard and dialogs. The API-level specs behave the same in any browser,
    // so running them three times would only triple a ten-minute suite.
    ...(process.env.CROSS_BROWSER
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"] }, testMatch: BROWSER_SPECS },
          { name: "webkit", use: { ...devices["Desktop Safari"] }, testMatch: BROWSER_SPECS },
        ]
      : []),
  ],
});
