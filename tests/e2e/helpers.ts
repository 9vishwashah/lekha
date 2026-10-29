import { type Page, test, expect } from "@playwright/test";
import net from "node:net";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";

// Test workers call Clerk's API directly (sign-in tickets); same slow-network allowance as the app.
net.setDefaultAutoSelectFamilyAttemptTimeout(2500);

export const configured = Boolean(
  process.env.E2E_USER_A_EMAIL &&
    process.env.E2E_USER_A_PASSWORD &&
    process.env.E2E_USER_B_EMAIL &&
    process.env.E2E_USER_B_PASSWORD &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.CLERK_SECRET_KEY,
);

export function requireE2E() {
  test.skip(!configured, "Set E2E_USER_A/B credentials, Clerk keys and Supabase env to run end-to-end tests (see README).");
}

export async function signInAs(page: Page, who: "A" | "B") {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  // Ticket-based sign-in through the Backend API: no password form, no new-device challenge.
  await clerk.signIn({ page, emailAddress: process.env[`E2E_USER_${who}_EMAIL`]! });
  await page.waitForFunction(() => Boolean((window as unknown as { Clerk?: { user?: unknown } }).Clerk?.user));
  await page.goto("/dashboard");
  if (page.url().includes("/onboarding")) {
    await page.getByLabel("Workspace name").fill(`E2E ${who} ${Date.now()}`);
    await page.getByRole("button", { name: "Create workspace" }).click();
    await page.waitForURL("**/dashboard");
  }
}

/** Share and invite links carry the app's public URL; open them on the server under test. */
export function onTestServer(page: Page, link: string) {
  const u = new URL(link);
  return new URL(u.pathname + u.search, new URL(page.url()).origin).toString();
}

export const unique = (label: string) => `${label} ${Date.now().toString(36)}`;

/** Fails if anything on the page is wider than the viewport. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

export async function addEntry(page: Page, direction: "Money in" | "Money out", amount: string, description: string) {
  await page.getByRole("button", { name: "Add entry" }).first().click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: direction }).click();
  await sheet.getByLabel("Amount").fill(amount);
  await sheet.getByLabel("Description").fill(description);
  await sheet.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByText(/Saved as/)).toBeVisible();
}
