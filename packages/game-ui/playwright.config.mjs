import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "source", testIgnore: "production.test.mjs" },
    {
      name: "production",
      testMatch: "production.test.mjs",
      use: { baseURL: "http://127.0.0.1:4174" },
    },
  ],
  webServer: [
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort",
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false,
    },
  ],
});
