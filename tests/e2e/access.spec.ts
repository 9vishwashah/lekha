import { expect, test } from "@playwright/test";
import { addEntry, onTestServer, requireE2E, signInAs, unique } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("tenant isolation and collaborators", () => {
  requireE2E();

  test("user B cannot open user A's ledger or export it, and an invited collaborator sees only that ledger", async ({ browser }) => {
    const a = await (await browser.newContext()).newPage();
    await signInAs(a, "A");
    await a.goto("/ledgers/new");
    const name = unique("Private");
    await a.getByLabel("Ledger name").fill(name);
    await a.getByRole("button", { name: "Create ledger" }).click();
    await a.waitForURL(/\/ledgers\/[0-9a-f-]{36}$/);
    const ledgerUrl = a.url();
    const ledgerId = ledgerUrl.split("/").pop()!;
    await addEntry(a, "Money out", "999", "Owner only entry");

    const b = await (await browser.newContext()).newPage();
    await signInAs(b, "B");
    await b.goto(ledgerUrl);
    await expect(b.getByText("Not here")).toBeVisible();
    const exp = await b.request.get(`/api/export/ledger/${ledgerId}?format=csv`);
    expect(exp.status()).toBe(404);

    // Invite B as a collaborator who may add entries
    await a.goto(`${ledgerUrl}/settings`);
    await a.getByRole("checkbox", { name: "Add entries" }).first().check();
    await a.getByRole("button", { name: "Create invitation link" }).click();
    const invite = onTestServer(a, (await a.locator("p.font-mono").first().innerText()).trim());

    await b.goto(invite);
    await b.getByRole("button", { name: "Accept invitation" }).click();
    await b.waitForURL(`**/ledgers/${ledgerId}`);
    await addEntry(b, "Money in", "50", "Added by collaborator");
    await b.goto("/shared");
    await expect(b.getByText(name)).toBeVisible();

    // The collaborator's entry is attributed in the owner's activity log
    await a.goto(`${ledgerUrl}/activity`);
    await expect(a.getByText("collaborator").first()).toBeVisible();

    // Revoke and confirm access is gone
    await a.goto(`${ledgerUrl}/settings`);
    await a.getByRole("button", { name: "Remove" }).first().click();
    await expect(a.getByText("Access removed")).toBeVisible();
    await b.goto(ledgerUrl);
    await expect(b.getByText("Not here")).toBeVisible();
  });
});
