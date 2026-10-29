import { expect, test } from "@playwright/test";
import { requireE2E, signInAs, unique } from "./helpers";

test.describe("friends in shared accounts are client accounts", () => {
  requireE2E();

  test("a new person added to a shared account rolls up to Home and their client page", async ({ page }) => {
    await signInAs(page, "A");
    const friend = unique("Aagam");

    await page.goto("/ledgers/new?type=personal");
    await page.getByLabel("Ledger name").fill(unique("Dinner club"));
    await page.getByRole("button", { name: "New person" }).click();
    await page.getByLabel("Name", { exact: true }).fill(friend);
    await page.getByRole("button", { name: "Add to client accounts" }).click();
    await expect(page.getByRole("button", { name: new RegExp(friend) })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Create ledger" }).click();
    await page.waitForURL(/\/ledgers\/[0-9a-f-]{36}$/);

    // I pay ₹240, split equally: the friend owes me ₹120.
    await page.getByRole("button", { name: "Add expense" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByLabel("What was it for?").fill("Dinner");
    await sheet.getByLabel("Total amount").fill("240");
    await expect(sheet.getByText(/owes/).first()).toBeVisible();
    await sheet.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByText(`${friend} owes you`).first()).toBeVisible();

    await page.goto("/dashboard");
    const tile = page.getByRole("link", { name: /People owe you/ });
    await expect(tile).toContainText("₹");
    await expect(tile).toContainText("incl. shared");

    await page.goto(`/contractors?q=${encodeURIComponent(friend)}`);
    await page.getByRole("link", { name: new RegExp(friend) }).first().click();
    await page.waitForURL(/\/contractors\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Shared accounts" })).toBeVisible();
    await expect(page.getByText("₹120").first()).toBeVisible();
  });
});
