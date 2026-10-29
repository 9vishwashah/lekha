import { expect, test } from "@playwright/test";
import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { addEntry, onTestServer, requireE2E, signInAs, unique } from "./helpers";
import { basicWorkbook } from "../fixtures/make-workbooks";

test.describe.configure({ mode: "serial" });

test.describe("owner workflows", () => {
  requireE2E();

  test("contractor, basic ledger, running balance, share link, live update, revoke", async ({ page, browser }) => {
    await signInAs(page, "A");

    // Contractor
    const contractor = unique("Ramesh Saini");
    await page.goto("/contractors");
    await page.getByRole("button", { name: "Add client" }).click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill(contractor);
    await page.getByRole("dialog").getByLabel("Phone").fill("9876543210");
    await page.getByRole("dialog").getByRole("button", { name: "Add client" }).click();
    await expect(page.getByRole("heading", { name: contractor })).toBeVisible();

    // Basic ledger with opening balance
    await page.goto("/ledgers/new");
    const ledgerName = unique("Site work");
    await page.getByLabel("Ledger name").fill(ledgerName);
    await page.locator('select[name="contractor_id"]').selectOption({ label: contractor });
    await page.locator('input[name="opening_balance"]').fill("1000");
    await page.getByRole("button", { name: "Create ledger" }).click();
    await expect(page.getByRole("heading", { name: ledgerName })).toBeVisible();

    await addEntry(page, "Money in", "10000", "Cash from owner");
    await addEntry(page, "Money out", "2500.50", "Cement");
    // 1000 + 10000 − 2500.50
    await expect(page.getByText("₹8,499").first()).toBeVisible();

    // Share link
    await page.getByRole("button", { name: "Share" }).click();
    await page.getByRole("button", { name: "Create share link" }).click();
    const link = onTestServer(page, (await page.getByRole("dialog").locator("p.font-mono").innerText()).trim());
    expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
    await page.keyboard.press("Escape");

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    await pub.goto(link);
    await expect(pub.getByRole("heading", { name: ledgerName })).toBeVisible();
    await expect(pub.getByText("Cement")).toBeVisible();
    // Public page has no way to edit
    await expect(pub.getByRole("button", { name: /add entry/i })).toHaveCount(0);
    const write = await pub.request.post(link.replace("/s/", "/api/share/"), { data: {} });
    expect([404, 405]).toContain(write.status());

    // A new entry appears on the open public page without a new link
    await addEntry(page, "Money out", "700", "Labour week 1");
    await expect(pub.getByText("Labour week 1")).toBeVisible({ timeout: 45_000 });

    // Revoke
    await page.getByRole("button", { name: "Share" }).click();
    await page.getByRole("button", { name: "Turn off sharing" }).click();
    await expect(page.getByText("Link turned off")).toBeVisible();
    await pub.reload();
    await expect(pub.getByText("This link is no longer active")).toBeVisible();
    await visitor.close();
  });

  test("taxation ledger computes the workbook example and exports reconcile", async ({ page }) => {
    await signInAs(page, "A");
    await page.goto("/ledgers/new?type=taxation");
    const name = unique("Rishabh Sales");
    await page.getByLabel("Ledger name").fill(name);
    await page.getByRole("button", { name: "Create ledger" }).click();
    await page.getByRole("button", { name: "Add entry" }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("radio", { name: "Bill" }).click();
    await sheet.getByLabel("Taxable bill amount").fill("1000000");
    await expect(sheet.getByText("₹11,70,000.00").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Save entry" }).click();
    await expect(page.getByText(/Saved as TX-0001/)).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    await page.getByRole("link", { name: /Excel workbook/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);

    const pdf = await page.request.get(page.url().replace(/\/ledgers\//, "/api/export/ledger/").replace(/\?.*$/, "") + "?format=pdf");
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
  });

  test("advance with partial recovery, and an expense paid from a ledger", async ({ page }) => {
    await signInAs(page, "A");
    await page.goto("/advances/new");
    await page.getByLabel("Amount").fill("50000");
    await page.getByLabel("Paid from a ledger").selectOption({ index: 0 });
    await page.getByRole("button", { name: "Record advance" }).click();
    await page.waitForURL(/\/advances\/[0-9a-f-]{36}$/);
    await page.getByLabel("Amount").fill("20000");
    await page.getByRole("button", { name: "Record cash back" }).click();
    await expect(page.getByText("₹30,000").first()).toBeVisible();
    await page.getByLabel("Amount").fill("30000.01");
    await expect(page.getByText("That is more than what is outstanding")).toBeVisible();

    await page.goto("/expenses/new");
    await page.getByLabel("Amount").fill("4200");
    await page.getByLabel("What was it for?").fill("Cement 10 bags");
    await page.getByRole("button", { name: "Save expense" }).click();
    await page.waitForURL("**/expenses");
    await expect(page.getByText("Cement 10 bags")).toBeVisible();
  });

  test("imports a workbook with preview and refuses the same sheet twice", async ({ page }) => {
    await signInAs(page, "A");
    await page.goto("/ledgers/new");
    await page.getByLabel("Ledger name").fill(unique("Imported"));
    await page.getByRole("button", { name: "Create ledger" }).click();
    await page.getByRole("link", { name: "Import" }).first().click();

    const dir = path.join(process.cwd(), "test-results");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "ramesh.xlsx");
    await writeFile(file, Buffer.from(await basicWorkbook()));
    await page.locator("input[type=file]").setInputFiles(file);
    await expect(page.getByRole("button", { name: "Transactions" })).toBeVisible();
    await page.getByRole("checkbox", { name: /Import without/ }).check();
    await page.getByRole("button", { name: /Import \d+ entries/ }).click();
    await page.waitForURL(/\/ledgers\/[0-9a-f-]{36}$/);
    await expect(page.getByText("₹31,500").first()).toBeVisible();

    await page.getByRole("link", { name: "Import" }).first().click();
    await page.locator("input[type=file]").setInputFiles(file);
    await page.getByRole("checkbox", { name: /Import without/ }).check();
    await page.getByRole("button", { name: /Import \d+ entries/ }).click();
    await expect(page.getByText(/already been imported/)).toBeVisible();
  });
});
