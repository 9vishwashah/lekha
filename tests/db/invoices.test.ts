import { describe, expect, it } from "vitest";
import { as, createDb, rpc } from "./harness";
import { computeInvoice } from "@/lib/domain/invoice";
import { buildStatement } from "@/lib/domain/ledger";
import { toDecimal } from "@/lib/domain/money";
import { type InvoiceCard, cardVersion } from "@/lib/invoices/card";

const OWNER = "user_owner";
const VIEWER = "user_viewer";
const OUTSIDER = "user_outsider";
const j = (v: unknown) => JSON.stringify(v);
const TOKEN = "a".repeat(43);
type Db = Awaited<ReturnType<typeof createDb>>;

async function setup() {
  const db = await createDb();
  const ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["VJAS", "Vishwa", null]);
  await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "VJAS", state_code: "27", number_prefix: "VJAS", number_padding: 3 })]);
  const client = await as(db, OWNER, async (q) =>
    (await q<{ id: string }>(`insert into public.contractors (workspace_id, name, created_by) values ($1, 'Regal Impex', $2) returning id`, [ws, OWNER]))[0].id,
  );
  const ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Regal", ledger_type: "basic", perspective: "party", contractor_id: client })]);
  return { db, ws, client, ledger };
}

const draft = (ws: string, extra: Record<string, unknown> = {}) => ({
  workspace_id: ws,
  invoice_type: "service",
  invoice_date: "2026-10-24",
  due_date: "2026-11-07",
  client_name: "Regal Impex",
  items: [{ name: "Website", quantity: "1", rate: "25000" }],
  ...extra,
});

const save = (db: Db, p: unknown) => rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j(p)]);
const issue = (db: Db, id: string, token = TOKEN) => rpc<{ invoice_no: string }>(db, OWNER, "public.issue_invoice($1, $2, $3)", [id, token, null]);
const pay = (db: Db, id: string, p: Record<string, unknown>) => rpc<{ id: string; duplicate: boolean }>(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ paid_on: "2026-10-30", mode: "upi", ...p })]);
const inv = async (db: Db, id: string) =>
  (await as(db, OWNER, (q) => q<Record<string, string>>("select status, invoice_no, grand_total, amount_received, transaction_id, paid_at from public.invoices where id = $1", [id])))[0];

/** The ledger's party balance, through the same statement code every ledger screen uses. */
async function partyBalance(db: Db, ledger: string) {
  const rows = await as(db, OWNER, (q) =>
    q<{ seq: number; txn_date: string; direction: "in" | "out"; amount: string; kind: "regular"; is_cash: boolean; affects_party: boolean; status: "posted" }>(
      "select seq, txn_date::text, direction, amount, kind, is_cash, affects_party, status from public.transactions where ledger_id = $1",
      [ledger],
    ),
  );
  return { closing: toDecimal(buildStatement({ perspective: "party", opening_balance: "0" }, rows).closing), rows };
}

describe("invoice totals", () => {
  it("agree between the database and the live preview", async () => {
    const { db, ws } = await setup();
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "VJAS", state_code: "27", gst_registered: true, gstin: "27ABCDE1234F1Z5" })]);
    const cases = [
      { place: "27", discount: ["percent", "10"], round: false, items: [["3", "333.33", "0", "18"], ["1.5", "1000", "5", "12"], ["2", "99.99", "0", "5"]] },
      { place: "29", discount: ["amount", "100.05"], round: true, items: [["1", "1999.99", "12.5", "18"], ["7", "14.29", "0", "28"]] },
      { place: "27", discount: ["amount", "0"], round: false, items: [["0.333", "100.01", "0", "18"]] },
    ] as const;
    for (const c of cases) {
      const id = await save(db, draft(ws, {
        invoice_type: "gst", place_of_supply: c.place, discount_kind: c.discount[0], discount_value: c.discount[1], round_off: c.round,
        charge_label: "Shipping", charge_amount: "50.50",
        items: c.items.map(([quantity, rate, discount_percent, tax_rate], i) => ({ name: `Line ${i}`, hsn: "9983", quantity, rate, discount_percent, tax_rate })),
      }));
      const [row] = await as(db, OWNER, (q) => q<Record<string, string>>("select subtotal, discount_total, taxable_total, cgst_total, sgst_total, igst_total, rounding, grand_total, supply_type from public.invoices where id = $1", [id]));
      const ts = computeInvoice({
        lines: c.items.map(([quantity, rate, discount_percent, tax_rate]) => ({ quantity, rate, discount_percent, tax_rate })),
        gstEnabled: true, sellerState: "27", placeOfSupply: c.place, discountKind: c.discount[0], discountValue: c.discount[1], chargeAmount: "50.50", roundOff: c.round,
      });
      expect({ sub: toDecimal(ts.subtotal), d: toDecimal(ts.discount), t: toDecimal(ts.taxable), c: toDecimal(ts.cgst), s: toDecimal(ts.sgst), i: toDecimal(ts.igst), g: toDecimal(ts.grand), st: ts.supply }).toEqual({
        sub: Number(row.subtotal).toFixed(2), d: Number(row.discount_total).toFixed(2), t: Number(row.taxable_total).toFixed(2), c: Number(row.cgst_total).toFixed(2),
        s: Number(row.sgst_total).toFixed(2), i: Number(row.igst_total).toFixed(2), g: Number(row.grand_total).toFixed(2), st: row.supply_type,
      });
    }
  });

  it("never applies GST for a business that is not registered", async () => {
    const { db, ws } = await setup();
    const id = await save(db, draft(ws, { gst_enabled: true, items: [{ name: "Work", quantity: "1", rate: "1000", tax_rate: "18" }] }));
    expect(Number((await inv(db, id)).grand_total)).toBe(1000);
    await expect(save(db, draft(ws, { invoice_type: "gst" }))).rejects.toThrow(/GST registration/);
  });
});

describe("issuing", () => {
  it("numbers invoices without gaps per series, and a draft has no number or receivable", async () => {
    const { db, ws, ledger } = await setup();
    const a = await save(db, draft(ws, { ledger_id: ledger }));
    expect((await inv(db, a)).invoice_no).toBeNull();
    expect((await partyBalance(db, ledger)).closing).toBe("0.00");
    expect((await issue(db, a)).invoice_no).toBe("VJAS/2026-27/001");
    const b = await save(db, draft(ws));
    expect((await issue(db, b, "b".repeat(43))).invoice_no).toBe("VJAS/2026-27/002");
    const p = await save(db, draft(ws, { invoice_type: "proforma" }));
    expect((await issue(db, p, "c".repeat(43))).invoice_no).toBe("PI/2026-27/001");
    // A financial year rollover starts the series again.
    const next = await save(db, draft(ws, { invoice_date: "2027-04-02", due_date: null }));
    expect((await issue(db, next, "d".repeat(43))).invoice_no).toBe("VJAS/2027-28/001");
  });

  it("refuses a repeated custom number, and issuing twice", async () => {
    const { db, ws } = await setup();
    const a = await save(db, draft(ws, { invoice_no: "011/Oct/26" }));
    await issue(db, a);
    await expect(save(db, draft(ws, { invoice_no: "011/oct/26" }))).rejects.toThrow(/already used/);
    await expect(issue(db, a, "b".repeat(43))).rejects.toThrow(/already been issued/);
  });

  it("freezes issued invoices", async () => {
    const { db, ws } = await setup();
    const a = await save(db, draft(ws));
    await issue(db, a);
    await expect(save(db, draft(ws, { id: a, items: [{ name: "Cheaper", quantity: "1", rate: "1" }] }))).rejects.toThrow(/cannot be edited/);
    await rpc(db, OWNER, "public.amend_issued_invoice($1, $2::jsonb)", [a, j({ notes: "New note", due_date: "2026-12-01" })]);
    expect(Number((await inv(db, a)).grand_total)).toBe(25000);
  });

  it("validates a GST tax invoice before calling it one", async () => {
    const { db, ws } = await setup();
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "VJAS", gst_registered: true, gstin: "27ABCDE1234F1Z5" })]);
    const noPlace = await save(db, draft(ws, { invoice_type: "gst", items: [{ name: "Work", hsn: "9983", quantity: "1", rate: "1000", tax_rate: "18" }] }));
    await expect(issue(db, noPlace)).rejects.toThrow(/place of supply/);
    const noHsn = await save(db, draft(ws, { invoice_type: "gst", place_of_supply: "27", items: [{ name: "Work", quantity: "1", rate: "1000", tax_rate: "18" }] }));
    await expect(issue(db, noHsn)).rejects.toThrow(/HSN or SAC/);
    await expect(rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ gst_registered: true, gstin: "bad" })])).rejects.toThrow(/valid 15-character/);
  });
});

describe("the ledger", () => {
  it("issuing posts one non-cash receivable; each payment one receipt; nothing is counted twice", async () => {
    const { db, ws, ledger } = await setup();
    const id = await save(db, draft(ws, { ledger_id: ledger }));
    await issue(db, id);
    await rpc(db, OWNER, "public.mark_invoice_shared($1)", [id]);
    await rpc(db, OWNER, "public.mark_invoice_shared($1)", [id]);
    let book = await partyBalance(db, ledger);
    expect(book.closing).toBe("25000.00");
    expect(book.rows).toHaveLength(1);
    expect(book.rows[0]).toMatchObject({ kind: "invoice", is_cash: false, affects_party: true });

    await pay(db, id, { amount: "10000", reference: "UTR1" });
    await pay(db, id, { amount: "5000", reference: "UTR2" });
    expect((await partyBalance(db, ledger)).closing).toBe("10000.00");
    expect(Number((await inv(db, id)).amount_received)).toBe(15000);
    await pay(db, id, { amount: "10000", reference: "UTR3" });
    book = await partyBalance(db, ledger);
    expect(book.closing).toBe("0.00");
    expect(book.rows).toHaveLength(4);
    expect((await inv(db, id)).paid_at).toBeTruthy();

    // The invoice and the ledger reconcile: receipts in the ledger are exactly the invoice payments.
    const [sums] = await as(db, OWNER, (q) => q<{ a: string; b: string }>(
      `select (select sum(amount) from public.invoice_payments where invoice_id = $1 and status = 'confirmed') a,
              (select sum(amount) from public.transactions where ledger_id = $2 and kind = 'regular' and status = 'posted') b`, [id, ledger]));
    expect(Number(sums.a)).toBe(Number(sums.b));
  });

  it("stops over-recording, duplicate references and retried submissions", async () => {
    const { db, ws, ledger } = await setup();
    const id = await save(db, draft(ws, { ledger_id: ledger }));
    await issue(db, id);
    await expect(pay(db, id, { amount: "25000.01" })).rejects.toThrow(/more than the balance/);
    await pay(db, id, { amount: "1000", reference: "UTR9", idempotency_key: "key-12345678" });
    expect((await pay(db, id, { amount: "1000", reference: "UTR9", idempotency_key: "key-12345678" })).duplicate).toBe(true);
    await expect(pay(db, id, { amount: "1000", reference: "utr9" })).rejects.toThrow(/already recorded/);
    await pay(db, id, { amount: "24500", allow_excess: true });
    expect((await partyBalance(db, ledger)).closing).toBe("-500.00");
    expect(Number((await inv(db, id)).amount_received)).toBe(25500);
  });

  it("reverses a payment by contra entry and keeps the history", async () => {
    const { db, ws, ledger } = await setup();
    const id = await save(db, draft(ws, { ledger_id: ledger }));
    await issue(db, id);
    const p = await pay(db, id, { amount: "25000" });
    expect((await inv(db, id)).paid_at).toBeTruthy();
    await rpc(db, OWNER, "public.reverse_invoice_payment($1, $2, $3)", [p.id, "Cheque bounced", "correction"]);
    expect(Number((await inv(db, id)).amount_received)).toBe(0);
    expect((await inv(db, id)).paid_at).toBeNull();
    expect((await partyBalance(db, ledger)).closing).toBe("25000.00");
    const rows = await as(db, OWNER, (q) => q<{ status: string }>("select status from public.invoice_payments where invoice_id = $1", [id]));
    expect(rows).toEqual([{ status: "reversed" }]);
    await expect(rpc(db, OWNER, "public.reverse_invoice_payment($1, $2, $3)", [p.id, "Again", "refund"])).rejects.toThrow(/already been reversed/);
  });

  it("cancelling clears the receivable, but not while payments stand", async () => {
    const { db, ws, ledger } = await setup();
    const id = await save(db, draft(ws, { ledger_id: ledger }));
    await issue(db, id);
    const p = await pay(db, id, { amount: "100" });
    await expect(rpc(db, OWNER, "public.cancel_invoice($1, $2)", [id, "Wrong client"])).rejects.toThrow(/Reverse them first/);
    await rpc(db, OWNER, "public.reverse_invoice_payment($1, $2, $3)", [p.id, "Mistake", "correction"]);
    await rpc(db, OWNER, "public.cancel_invoice($1, $2)", [id, "Wrong client"]);
    expect((await partyBalance(db, ledger)).closing).toBe("0.00");
    expect(await rpc(db, null, "public.get_public_invoice($1)", [TOKEN])).toBeNull();
  });

  it("entries an invoice owns cannot be changed from the ledger", async () => {
    const { db, ws, ledger } = await setup();
    const id = await save(db, draft(ws, { ledger_id: ledger }));
    await issue(db, id);
    await pay(db, id, { amount: "1000" });
    const rows = await as(db, OWNER, (q) => q<{ id: string; kind: string }>("select id, kind from public.transactions where ledger_id = $1", [ledger]));
    for (const r of rows) {
      await expect(rpc(db, OWNER, "public.void_transaction($1, $2)", [r.id, "Oops"])).rejects.toThrow(/belongs to invoice/);
      await expect(rpc(db, OWNER, "public.reverse_transaction($1, $2, $3)", [r.id, "Oops", "2026-11-01"])).rejects.toThrow(/belongs to invoice/);
    }
    const receipt = rows.find((r) => r.kind === "regular")!;
    await expect(rpc(db, OWNER, "public.amend_transaction($1, $2::jsonb)", [receipt.id, j({ amount: "1" })])).rejects.toThrow(/belongs to invoice/);
    // Wording can still be tidied; the money cannot.
    await rpc(db, OWNER, "public.amend_transaction($1, $2::jsonb)", [receipt.id, j({ notes: "Paid at the office" })]);
  });

  it("a proforma posts nothing and takes no payments; it converts to an invoice", async () => {
    const { db, ws, ledger } = await setup();
    const id = await save(db, draft(ws, { invoice_type: "proforma", ledger_id: ledger }));
    await issue(db, id);
    expect((await partyBalance(db, ledger)).rows).toHaveLength(0);
    await expect(pay(db, id, { amount: "100" })).rejects.toThrow(/proforma/i);
    const final = await rpc<string>(db, OWNER, "public.duplicate_invoice($1, $2)", [id, "service"]);
    await issue(db, final, "b".repeat(43));
    expect((await partyBalance(db, ledger)).closing).toBe("25000.00");
  });
});

describe("the public link", () => {
  async function issued() {
    const s = await setup();
    await rpc(s.db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [s.ws, j({ business_name: "VJAS", state_code: "27" })]);
    const profile = await rpc<string>(s.db, OWNER, "public.save_payment_profile($1, $2::jsonb)", [s.ws, j({ label: "HDFC", upi_id: "vjas@ybl", upi_payee: "VJAS", bank_holder: "VJAS", bank_name: "HDFC", bank_account: "50200101095482", bank_ifsc: "HDFC0000423" })]);
    const id = await save(s.db, draft(s.ws, { ledger_id: s.ledger, notes: "Thanks", payment_config: { profile_id: profile, upi: true, bank: false } }));
    await issue(s.db, id);
    return { ...s, id, profile };
  }

  it("shows one invoice, only selected payment details, and no internal ids", async () => {
    const { db, id, ws, ledger } = await issued();
    const v = await rpc<Record<string, unknown>>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    const text = JSON.stringify(v);
    expect(v).toMatchObject({ invoice_no: "VJAS/2026-27/001", status: "issued" });
    expect(text).toContain("vjas@ybl");
    expect(text).not.toContain("50200101095482"); // bank was not selected for this invoice
    for (const secret of [id, ws, ledger, OWNER]) expect(text).not.toContain(secret);
    expect(await rpc(db, null, "public.get_public_invoice($1)", ["z".repeat(43)])).toBeNull();
    expect(await rpc(db, null, "public.get_public_invoice($1)", ["' or 1=1 --"])).toBeNull();
    const card = await rpc<Record<string, unknown>>(db, null, "public.get_invoice_card($1)", [TOKEN]);
    expect(card).toMatchObject({ amount: 25000 });
    expect(JSON.stringify(card)).not.toContain("Regal Impex");
  });

  it("stops at once when revoked, rotated or expired, and a draft has no link", async () => {
    const { db, id, ws } = await issued();
    await rpc(db, OWNER, "public.rotate_invoice_link($1, $2, $3, $4)", [id, "n".repeat(43), null, null]);
    expect(await rpc(db, null, "public.get_public_invoice($1)", [TOKEN])).toBeNull();
    expect(await rpc(db, null, "public.get_public_invoice($1)", ["n".repeat(43)])).not.toBeNull();
    await rpc(db, OWNER, "public.rotate_invoice_link($1, $2, $3, $4)", [id, "m".repeat(43), null, "2020-01-01T00:00:00Z"]);
    expect(await rpc(db, null, "public.get_public_invoice($1)", ["m".repeat(43)])).toBeNull();
    await rpc(db, OWNER, "public.rotate_invoice_link($1, $2, $3, $4)", [id, "k".repeat(43), null, null]);
    await rpc(db, OWNER, "public.revoke_invoice_link($1)", [id]);
    expect(await rpc(db, null, "public.get_public_invoice($1)", ["k".repeat(43)])).toBeNull();
    const d = await save(db, draft(ws));
    expect(await rpc(db, OWNER, "public.invoice_link_secret($1)", [d])).toBeNull();
  });

  it("a visitor cannot write, and a client claim never moves money", async () => {
    const { db, id, ledger } = await issued();
    await expect(as(db, null, (q) => q("select public.record_invoice_payment($1, $2::jsonb)", [id, j({ amount: "1", paid_on: "2026-10-30" })]))).rejects.toThrow(/permission denied/);
    await expect(as(db, null, (q) => q("select id from public.invoices"))).rejects.toThrow(/permission denied/);

    const claim = await rpc<{ proof_path: string }>(db, null, "public.submit_payment_claim($1, $2::jsonb)", [TOKEN, j({ amount: "25000", paid_on: "2026-10-30", mode: "upi", reference: "UTR55", proof_mime: "image/png" })]);
    expect(claim.proof_path).toMatch(/proofs\/[0-9a-f]{64}$/);
    expect(Number((await inv(db, id)).amount_received)).toBe(0);
    expect((await partyBalance(db, ledger)).closing).toBe("25000.00");
    const pub = await rpc<{ status: string; pending_claims: number }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect(pub).toMatchObject({ status: "issued", pending_claims: 1 });

    const [c] = await as(db, OWNER, (q) => q<{ id: string }>("select id from public.invoice_payment_submissions where invoice_id = $1", [id]));
    await rpc(db, OWNER, "public.review_payment_submission($1, true, $2::jsonb)", [c.id, j({ amount: "20000" })]);
    expect(Number((await inv(db, id)).amount_received)).toBe(20000);
    expect((await partyBalance(db, ledger)).closing).toBe("5000.00");
    await expect(rpc(db, OWNER, "public.review_payment_submission($1, true, '{}'::jsonb)", [c.id])).rejects.toThrow(/already been reviewed/);
  });

  it("serves only files the issuer approved, for one invoice", async () => {
    const { db, id, ws } = await issued();
    const path = (n: string) => `${ws}/${id}/${n}`;
    const add = (n: string, visible: boolean) =>
      rpc<string>(db, OWNER, "public.add_invoice_attachment($1, $2::jsonb)", [id, j({ storage_path: path(n), file_name: n, mime_type: "application/pdf", size_bytes: 10, sha256: "0".repeat(64), client_visible: visible })]);
    await add("private.pdf", false);
    const shown = await add("shown.pdf", true);
    const v = await rpc<{ files: { n: number; file_name: string }[] }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect(v.files.map((f) => f.file_name)).toEqual(["shown.pdf"]);
    expect(await rpc(db, null, "public.get_public_invoice_file($1, $2)", [TOKEN, 1])).toBeNull(); // the hidden one
    expect(await rpc(db, null, "public.get_public_invoice_file($1, $2)", [TOKEN, 2])).toMatchObject({ file_name: "shown.pdf" });
    expect(await as(db, null, (q) => q<{ ok: boolean }>("select app.invoice_file_public($1) ok", [path("private.pdf")]))).toEqual([{ ok: false }]);
    expect(await as(db, null, (q) => q<{ ok: boolean }>("select app.invoice_file_public($1) ok", [path("shown.pdf")]))).toEqual([{ ok: true }]);
    await rpc(db, OWNER, "public.set_attachment_visibility($1, false)", [shown]);
    expect(await as(db, null, (q) => q<{ ok: boolean }>("select app.invoice_file_public($1) ok", [path("shown.pdf")]))).toEqual([{ ok: false }]);
    await expect(rpc(db, OWNER, "public.add_invoice_attachment($1, $2::jsonb)", [id, j({ storage_path: `${ws}/other/x.pdf`, file_name: "x", mime_type: "application/pdf", size_bytes: 1, sha256: "0".repeat(64) })])).rejects.toThrow(/Upload the file again/);
  });
});

describe("tenancy and roles", () => {
  it("keeps every record inside its workspace", async () => {
    const { db, ws } = await setup();
    const id = await save(db, draft(ws));
    await issue(db, id);
    expect(await as(db, OUTSIDER, (q) => q("select id from public.invoices"))).toEqual([]);
    expect(await as(db, OUTSIDER, (q) => q("select id from public.invoice_items"))).toEqual([]);
    await expect(rpc(db, OUTSIDER, "public.save_invoice($1::jsonb)", [j(draft(ws))])).rejects.toThrow();
    await expect(pay(db, id, { amount: "1" }).then(() => rpc(db, OUTSIDER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ amount: "1", paid_on: "2026-10-30" })]))).rejects.toThrow();
    expect(await rpc(db, OUTSIDER, "public.invoice_link_secret($1)", [id])).toBeNull();
  });

  it("viewers read invoices but cannot act, and never see bank profiles", async () => {
    const { db, ws } = await setup();
    await rpc(db, OWNER, "public.save_payment_profile($1, $2::jsonb)", [ws, j({ label: "Bank", bank_account: "50200101095482", bank_ifsc: "HDFC0000423" })]);
    await rpc(db, VIEWER, "public.save_my_profile($1, $2)", ["View Only", "9876543210"]);
    await rpc(db, VIEWER, "public.set_my_username($1)", ["viewonly"]);
    await rpc(db, OWNER, "public.add_member_by_username($1, $2, $3)", [ws, "viewonly", "viewer"]);
    const id = await save(db, draft(ws));
    await issue(db, id);
    expect(await as(db, VIEWER, (q) => q("select id from public.invoices"))).toHaveLength(1);
    expect(await as(db, VIEWER, (q) => q("select id from public.invoice_payment_profiles"))).toEqual([]);
    await expect(rpc(db, VIEWER, "public.cancel_invoice($1, $2)", [id, "No"])).rejects.toThrow();
    await expect(as(db, OWNER, (q) => q("select token_hash from public.invoice_share_links"))).rejects.toThrow(/permission denied/);
  });
});

describe("the client page", () => {
  const file = (ws: string, id: string, n: string, role = "original", visible = false) =>
    j({ storage_path: `${ws}/${id}/${n}`, file_name: n, mime_type: "application/pdf", size_bytes: 10, sha256: "0".repeat(64), role, client_visible: visible });

  it("shows a saved QR on its own, and details saved after issuing", async () => {
    const { db, ws } = await setup();
    const id = await save(db, draft(ws));
    await issue(db, id);
    const view = () => rpc<{ payment: Record<string, { qr_path?: string; dynamic?: boolean }> }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect((await view()).payment).toEqual({});
    await rpc(db, OWNER, "public.save_payment_profile($1, $2::jsonb)", [ws, j({ label: "QR only", upi_qr_path: `${ws}/qr.png` })]);
    expect((await view()).payment.upi).toMatchObject({ qr_path: `${ws}/qr.png`, dynamic: false });
  });

  it("uses the default profile, and respects choosing to show nothing", async () => {
    const { db, ws } = await setup();
    await rpc(db, OWNER, "public.save_payment_profile($1, $2::jsonb)", [ws, j({ label: "Old", upi_id: "old@ybl" })]);
    const main = await rpc<string>(db, OWNER, "public.save_payment_profile($1, $2::jsonb)", [ws, j({ label: "Main", upi_id: "main@ybl", bank_account: "50200101095482", bank_ifsc: "HDFC0000423" })]);
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "VJAS", default_profile_id: main })]);
    const a = await save(db, draft(ws));
    await issue(db, a);
    const shown = await rpc<{ payment: { upi: { id: string }; bank: { account: string } } }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect(shown.payment.upi.id).toBe("main@ybl");
    expect(shown.payment.bank.account).toBe("50200101095482");
    const b = await save(db, draft(ws, { payment_config: { none: true } }));
    await issue(db, b, "b".repeat(43));
    expect((await rpc<{ payment: unknown }>(db, null, "public.get_public_invoice($1)", ["b".repeat(43)])).payment).toEqual({});
  });

  it("sends only your document, and shares it when you choose that", async () => {
    const { db, ws } = await setup();
    const id = await save(db, draft(ws, { source: "uploaded", invoice_no: "VJAS/INV/2026/001" }));
    await rpc(db, OWNER, "public.add_invoice_attachment($1, $2::jsonb)", [id, file(ws, id, "mine.pdf")]);
    await issue(db, id);
    const view = () => rpc<{ document_mode: string; files: { file_name: string; role: string }[] }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect((await view()).files).toEqual([]);
    await rpc(db, OWNER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ document_mode: "uploaded" })]);
    expect(await view()).toMatchObject({ document_mode: "uploaded", files: [{ file_name: "mine.pdf", role: "original" }] });
  });

  it("promotes an attached file, and refuses when there is no document", async () => {
    const { db, ws } = await setup();
    const id = await save(db, draft(ws));
    await issue(db, id);
    await expect(rpc(db, OWNER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ document_mode: "uploaded" })])).rejects.toThrow(/Attach your invoice document first/);
    await rpc(db, OWNER, "public.add_invoice_attachment($1, $2::jsonb)", [id, file(ws, id, "scan.pdf", "supporting")]);
    await rpc(db, OWNER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ document_mode: "both" })]);
    const v = await rpc<{ files: { role: string }[] }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect(v.files).toEqual([expect.objectContaining({ role: "original" })]);
  });

  it("carries the card colour and logos, and remembers the client's logo", async () => {
    const { db, ws, client } = await setup();
    await rpc(db, OWNER, "public.set_invoice_card_color($1, $2)", [ws, "#245E55"]);
    await rpc(db, OWNER, "public.set_invoice_brand_image($1, $2, $3)", [ws, "logo_path", `${ws}/logo.png`]);
    const id = await save(db, draft(ws, { contractor_id: client }));
    await issue(db, id);
    const view = () => rpc<{ card_color: string; seller: { logo_path: string }; client: { logo_path: string | null } }>(db, null, "public.get_public_invoice($1)", [TOKEN]);
    expect(await view()).toMatchObject({ card_color: "#245e55", seller: { logo_path: `${ws}/logo.png` } });
    await rpc(db, OWNER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ card_color: "#112233", client_logo_path: `${ws}/client.png` })]);
    expect(await view()).toMatchObject({ card_color: "#112233", client: { logo_path: `${ws}/client.png` } });
    const [c] = await as(db, OWNER, (q) => q<{ logo_path: string }>("select logo_path from public.contractors where id = $1", [client]));
    expect(c.logo_path).toBe(`${ws}/client.png`);
    await expect(rpc(db, OWNER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ client_logo_path: "other/x.png" })])).rejects.toThrow(/Upload the logo again/);
    await expect(rpc(db, OUTSIDER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ card_color: "#000000" })])).rejects.toThrow();
  });
});

describe("the link preview", () => {
  it("shows the current colour, logo, title and total, never the client", async () => {
    const { db, ws } = await setup();
    const id = await save(db, draft(ws, { title: "Old title" }));
    await issue(db, id);
    const card = () => rpc<InvoiceCard>(db, null, "public.get_invoice_card($1)", [TOKEN]);
    const first = await card();
    expect(first).toMatchObject({ title: "Old title", card_color: "#1d1d1b" });

    await rpc(db, OWNER, "public.set_invoice_card_color($1, $2)", [ws, "#245e55"]);
    expect((await card()).card_color).toBe("#245e55");
    await rpc(db, OWNER, "public.set_invoice_look($1, $2::jsonb)", [id, j({ card_color: "#112233" })]);
    expect((await card()).card_color).toBe("#112233");
    await rpc(db, OWNER, "public.set_invoice_title($1, $2)", [id, "New title"]);
    const latest = await card();
    expect(latest.title).toBe("New title");
    expect(latest.amount).toBe(25000);
    expect(JSON.stringify(latest)).not.toContain("Regal Impex");

    // The link's version follows what the preview shows, and nothing else.
    expect(cardVersion(latest)).not.toBe(cardVersion(first));
    await pay(db, id, { amount: "100" });
    expect(cardVersion(await card())).toBe(cardVersion(latest));
    expect(Number((await inv(db, id)).grand_total)).toBe(25000);
    await expect(rpc(db, OUTSIDER, "public.set_invoice_title($1, $2)", [id, "Hacked"])).rejects.toThrow();
  });
});
