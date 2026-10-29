import { defineConfig, devices } from "@playwright/test";
import net from "node:net";

// Same reason as src/instrumentation.ts: slow or IPv6-only networks need longer connection attempts.
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

// Same variables the app uses in development (Clerk, Supabase, E2E users). Never committed.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: the suite skips with a message.
}

/**
 * End-to-end tests run against a real Clerk development instance and a Supabase project with
 * the migrations applied. They need the variables listed in .env.example (E2E_* users). Without
 * them the suite skips with a message; it never substitutes mock data.
 */
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  // Tests share two Clerk test users; parallel sign-ins as the same user get throttled.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile.spec.ts/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "npm run dev", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120_000 },
});
