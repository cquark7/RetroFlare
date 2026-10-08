import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
    browserName: "chromium",
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run dev:e2e",
    url: "http://localhost:5174",
    reuseExistingServer: false,
    timeout: 120_000
  }
});
