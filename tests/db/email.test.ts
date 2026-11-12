import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";
import { loadBooksInput } from "./books-load";
import { computeBooks } from "@/lib/domain/books";
import { toDecimal } from "@/lib/domain/money";

const OWNER = "user_email_owner";
const TEAM = "user_email_team";
const SECRET = "s".repeat(32);
const j = (v: unknown) => JSON.stringify(v);
let db: Db;
let ws: string;
let wallet: string;
let client: string;

const one = async <T>(sql: string, params: unknown[] = []) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const balance = async (id: string) => Number(await rpc<string>(db, OWNER, "public.client_balance($1)", [id]));

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Mail Co", "Owner", null]);
  await rpc(db, OWNER, "public.save_my_profile($1, $2)", ["Vishwa Shah", null]);
  await rpc(db, TEAM, "public.save_my_profile($1, $2)", ["Teammate", null]);
  await db.query(`insert into public.workspace_members (workspace_id, user_id, role, display_name) values ($1, $2, 'member', 'Teammate')`, [ws, TEAM]);
  wallet = (await one<{ id: string }>("select id from public.ledgers where workspace_id = $1 and wallet_kind = 'cash'", [ws])).id;
  client = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, email, kind, created_by) values ($1, 'Regal', 'regal@example.com', 'business', $2) returning id`, [ws, OWNER])).id;
  await db.query("select app.set_cron_secret($1)", [SECRET]);
});

describe("client balance for emails", () => {
  it("adds up party ledger, loose invoice, advance and one-to-one account exactly as Books does", async () => {
    const party = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Regal work", ledger_type: "basic", perspective: "party", contractor_id: client, opening_balance: "1000" })]);
    await rpc(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: party, txn_date: "2026-11-01", kind: "regular", status: "posted", direction: "out", amount: "4000" })]);
    await rpc(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: party, txn_date: "2026-11-02", kind: "regular", status: "posted", direction: "in", amount: "1500" })]);
    await rpc(db, OWNER, "public.save_invoice_settings($1, $2::jsonb)", [ws, j({ business_name: "Mail Co", state_code: "27" })]);
    const inv = await rpc<string>(db, OWNER, "public.save_invoice($1::jsonb)", [j({ workspace_id: ws, invoice_type: "service", invoice_date: "2026-11-01", contractor_id: client, client_name: "Regal", items: [{ name: "Work", quantity: "1", rate: "700" }] })]);
    await rpc(db, OWNER, "public.issue_invoice($1, $2, $3)", [inv, "m".repeat(43), null]);
    const adv = await rpc<{ id: string }>(db, OWNER, "public.create_advance($1::jsonb)", [j({ workspace_id: ws, contractor_id: client, amount: "2000", given_date: "2026-11-01", ledger_id: wallet })]);
    await rpc(db, OWNER, "public.record_advance_allocation($1::jsonb)", [j({ advance_id: adv.id, kind: "recovery", amount: "500", alloc_date: "2026-11-05" })]);
    await rpc(db, OWNER, "public.record_client_payment($1::jsonb)", [j({ workspace_id: ws, contractor_id: client, direction: "paid", amount: "300", txn_date: "2026-11-06", ledger_id: wallet })]);

    const books = computeBooks(await loadBooksInput(db, ws, OWNER));
    const expected = books.positions.get(client)!;
    expect(await balance(client)).toBe(Number(toDecimal(expected)));
    expect(await balance(client)).toBe(1000 + 4000 - 1500 + 700 + 1500 + 300);
  });
});

describe("payment reminders", () => {
  it("allows one reminder per client every 12 hours, and needs an email", async () => {
    await rpc(db, OWNER, "public.note_client_reminder($1)", [client]);
    await expect(rpc(db, OWNER, "public.note_client_reminder($1)", [client])).rejects.toThrow(/Try again later/);
    const noMail = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'NoMail', 'personal', $2) returning id`, [ws, OWNER])).id;
    await expect(rpc(db, OWNER, "public.note_client_reminder($1)", [noMail])).rejects.toThrow(/Enter NoMail's email address/);
    // Typing an address when sending saves it on the card.
    await rpc(db, OWNER, "public.note_client_reminder($1, $2)", [noMail, " New@Example.com "]);
    expect((await one<{ email: string }>("select email from public.contractors where id = $1", [noMail])).email).toBe("new@example.com");
    await expect(rpc(db, OWNER, "public.note_client_reminder($1, $2)", [noMail, "not-an-email"])).rejects.toThrow(/valid email/);
  });

  it("a client on Lekha with no typed email can be reminded and get monthly statements", async () => {
    await rpc(db, "user_email_namya", "public.save_my_profile($1, $2)", ["Namya", null]);
    await rpc(db, "user_email_namya", "public.set_my_username($1)", ["namya"]);
    const namya = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Namya', 'personal', $2) returning id`, [ws, OWNER])).id;
    await rpc(db, OWNER, "public.link_client_by_username($1, $2)", [namya, "namya"]);
    await rpc(db, OWNER, "public.note_client_reminder($1)", [namya]);
    await rpc(db, OWNER, "public.set_client_monthly_statement($1, $2)", [namya, true]);
  });
});

describe("scheduled emails", () => {
  it("refuse without the secret", async () => {
    await expect(rpc(db, null, "public.email_digest_claim($1, $2)", ["wrong", 10])).rejects.toThrow(/Not allowed/);
    await expect(rpc(db, null, "public.email_monthly_claim($1, $2::date)", ["wrong", "2026-11-01"])).rejects.toThrow(/Not allowed/);
  });

  it("the activity digest picks unread alerts once, per person, and respects the email setting", async () => {
    await rpc(db, TEAM, "public.post_transaction($1::jsonb)", [j({ ledger_id: wallet, txn_date: "2026-11-07", kind: "regular", status: "posted", direction: "in", amount: "250" })]);
    const first = await rpc<{ user_id: string; items: { kind: string }[] }[]>(db, null, "public.email_digest_claim($1, $2)", [SECRET, 100]);
    expect(first.find((g) => g.user_id === OWNER)?.items.map((i) => i.kind)).toContain("entry");
    expect(await rpc(db, null, "public.email_digest_claim($1, $2)", [SECRET, 100])).toEqual([]);
    await rpc(db, OWNER, "public.set_my_email_prefs($1, $2)", [false, null]);
    await rpc(db, TEAM, "public.post_transaction($1::jsonb)", [j({ ledger_id: wallet, txn_date: "2026-11-07", kind: "regular", status: "posted", direction: "in", amount: "1" })]);
    expect((await rpc<{ user_id: string }[]>(db, null, "public.email_digest_claim($1, $2)", [SECRET, 100])).some((g) => g.user_id === OWNER)).toBe(false);
  });

  it("monthly: statements only to clients who opted in, a summary to the owner, each once a month", async () => {
    await rpc(db, OWNER, "public.set_client_monthly_statement($1, $2)", [client, true]);
    const m = await rpc<{ clients: { client_email: string; balance: number }[]; owners: { user_id: string; owed_to_you: number; top: unknown[] }[] }>(db, null, "public.email_monthly_claim($1, $2::date)", [SECRET, "2026-12-01"]);
    const regal = m.clients.find((c) => c.client_email === "regal@example.com")!;
    expect(regal).toBeTruthy();
    expect(Number(regal.balance)).toBe(await balance(client));
    expect(m.owners).toEqual([expect.objectContaining({ user_id: OWNER })]);
    const again = await rpc<{ clients: unknown[]; owners: unknown[] }>(db, null, "public.email_monthly_claim($1, $2::date)", [SECRET, "2026-12-15"]);
    expect(again).toMatchObject({ clients: [], owners: [] });
  });
});
