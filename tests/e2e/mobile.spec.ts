import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, requireE2E, signInAs } from "./helpers";

test.describe("phone layout", () => {
  requireE2E();

  test("main screens fit a phone without horizontal scrolling", async ({ page }) => {
    await signInAs(page, "A");
    for (const path of ["/dashboard", "/ledgers", "/contractors", "/expenses", "/advances", "/reports", "/reports/tax", "/settings", "/ledgers/new"]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    await page.goto("/ledgers");
    const first = page.locator("main a[href^='/ledgers/']").first();
    if (await first.count()) {
      await first.click();
      await expectNoHorizontalOverflow(page);
      await page.getByRole("button", { name: /^Add (entry|expense)$/ }).first().click();
      await expectNoHorizontalOverflow(page);
    }
  });

  test("landing and sign-in pages fit a phone", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalOverflow(page);
  });
});
