import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_edit_inv";
const j = (v: unknown) => JSON.stringify(v);
let db: Db;
let ws: string;
let ledger: string;
let n = 0;
const token = () => String(++n).padStart(4, "0").repeat(11).slice(0, 43);

const body = (extra: Record<string, unknown> = {}) => ({
  workspace_id: ws,
  invoice_type: "service",
  invoice_date: "2026-10-24",
  due_date: "2099-12-31",
  client_name: "Regal Impex",
  ledger_id: ledger,
  items: [{ name: "Website", quantity: "1", rate: "25000" }],
  ...extra,
});
const save = (p: unknown) => rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j(p)]);
const issue = (id: string) => rpc<{ invoice_no: string }>(db, OWNER, "public.issue_invoice($1, $2, $3)", [id, token(), null]);
const edit = (id: string, extra: Record<string, unknown>) => rpc<string>(db, OWNER, "public.edit_issued_invoice($1::jsonb)", [j({ ...body(extra), id })]);
const pay = (id: string, amount: string) => rpc(db, OWNER, "public.record_invoice_payment($1, $2::jsonb)", [id, j({ paid_on: "2026-10-30", mode: "upi", amount })]);
const one = async <T>(sql: string, params: unknown[]) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const inv = (id: string) => one<{ status: string; invoice_no: string; grand_total: string; amount_received: string; transaction_id: string; paid_at: string | null }>("select status, invoice_no, grand_total, amount_received, transaction_id, paid_at from public.invoices where id = $1", [id]);
const entries = (txn: string) => as(db, OWNER, (q) => q<{ amount: string; txn_date: string; description: string }>("select amount, txn_date::text, description from public.transactions where id = $1 or reversal_of = $1", [txn]));

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Edit", "Owner", null]);
  await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Edit Co", state_code: "27", number_prefix: "ED", number_padding: 3 })]);
  const client = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, created_by) values ($1, 'Regal Impex', $2) returning id`, [ws, OWNER])).id;
  ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Regal", ledger_type: "basic", perspective: "party", contractor_id: client })]);
});

describe("editing an issued invoice", () => {
  it("changes lines, total and date, keeps the number, and updates its one ledger entry", async () => {
    const id = await save(body());
    const { invoice_no } = await issue(id);
    const before = await inv(id);
    await edit(id, { invoice_date: "2026-10-26", items: [{ name: "Website", quantity: "2", rate: "20000" }] });
    const after = await inv(id);
    expect(after.invoice_no).toBe(invoice_no);
    expect(after.status).toBe("issued");
    expect(Number(after.grand_total)).toBe(40000);
    expect(after.transaction_id).toBe(before.transaction_id);
    const rows = await entries(after.transaction_id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBe(40000);
    expect(rows[0].txn_date).toBe("2026-10-26");
    const event = await one<{ detail: { after_issue: boolean; new_total: number } }>("select detail from public.invoice_events where invoice_id = $1 and event = 'edited' order by id desc limit 1", [id]);
    expect(event.detail.after_issue).toBe(true);
  });

  it("keeps payments; the total cannot go below what was received", async () => {
    const id = await save(body());
    await issue(id);
    await pay(id, "10000");
    await expect(edit(id, { items: [{ name: "Website", quantity: "1", rate: "5000" }] })).rejects.toThrow(/less than what was already received/);
    await edit(id, { items: [{ name: "Website", quantity: "1", rate: "10000" }] });
    const after = await inv(id);
    expect(Number(after.amount_received)).toBe(10000);
    expect(after.paid_at).not.toBeNull(); // now fully paid
  });

  it("refuses moving to another ledger, proforma switches, drafts and cancelled invoices", async () => {
    const other = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Other", ledger_type: "basic", opening_balance: "0" })]);
    const id = await save(body());
    await issue(id);
    await expect(edit(id, { ledger_id: other })).rejects.toThrow(/stays on its ledger/);
    await expect(edit(id, { invoice_type: "proforma" })).rejects.toThrow(/proforma/);
    const draft = await save(body());
    await expect(edit(draft, {})).rejects.toThrow(/still a draft/);
    await rpc(db, OWNER, "public.cancel_invoice($1, $2)", [id, "Wrong"]);
    await expect(edit(id, {})).rejects.toThrow(/cancelled/);
  });

  it("the normal save still refuses issued invoices, and the ledger entry still can't be changed directly", async () => {
    const id = await save(body());
    await issue(id);
    await expect(save({ ...body(), id })).rejects.toThrow(/cannot be edited here/);
    const { transaction_id } = await inv(id);
    await expect(as(db, OWNER, (q) => q("update public.transactions set amount = 1 where id = $1", [transaction_id]))).rejects.toThrow();
  });
});
