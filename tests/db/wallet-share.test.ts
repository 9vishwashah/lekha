import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_wallet_share";
const j = (v: unknown) => JSON.stringify(v);
const token = (s: string) => (s + "x".repeat(48)).slice(0, 48);
let db: Db;
let ws: string;
let wallet: string;
let party: string;

const one = async <T>(sql: string, params: unknown[] = []) => (await as(db, OWNER, (q) => q<T>(sql, params)))[0];
const post = (x: Record<string, unknown>) =>
  rpc<{ id: string }>(db, OWNER, "public.post_transaction($1::jsonb)", [j({ txn_date: "2026-01-01", kind: "regular", status: "posted", ...x })]);
const activity = async (id: string) => (await one<{ at: string }>("select last_activity_at::text as at from public.ledgers where id = $1", [id])).at;

type Payload = { transactions: { amount: number | string; direction: string; is_cash: boolean; counterparty?: string; tax?: unknown }[] };
const cash = (p: Payload) =>
  p.transactions.filter((t) => t.is_cash).reduce((acc, t) => acc + (t.direction === "in" ? 1 : -1) * Number(t.amount), 0);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Share", "Owner", null]);
  wallet = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "RSC Bank", ledger_type: "basic", wallet_kind: "bank", opening_balance: "0" })]);
  const client = (await one<{ id: string }>(`insert into public.contractors (workspace_id, name, kind, created_by) values ($1, 'Goodwill', 'business', $2) returning id`, [ws, OWNER])).id;
  party = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Goodwill", ledger_type: "taxation", contractor_id: client, opening_balance: "0" })]);
});

describe("sharing a wallet", () => {
  it("shows the money that went through it from party ledgers, so the balance matches the wallet screen", async () => {
    await post({ ledger_id: party, direction: "in", amount: "1170000", wallet_ledger_id: wallet });
    await post({ ledger_id: wallet, direction: "out", amount: "20000", counterparty: "Suresh" });
    await post({ ledger_id: party, direction: "out", amount: "5000" }); // not through this wallet
    const t = token("walletShare");
    await rpc(db, OWNER, "public.create_share_link($1, $2, $3, $4::jsonb)", [wallet, t, "c", "{}"]);
    const data = await rpc<Payload>(db, null, "public.get_shared_ledger($1)", [t]);
    expect(data.transactions).toHaveLength(2);
    expect(cash(data)).toBe(1150000);
    expect(data.transactions.find((r) => r.direction === "in")?.counterparty).toBe("Goodwill");
  });

  it("the party ledger's own share is unchanged", async () => {
    const t = token("partyShare");
    await rpc(db, OWNER, "public.create_share_link($1, $2, $3, $4::jsonb)", [party, t, "c", "{}"]);
    const data = await rpc<Payload>(db, null, "public.get_shared_ledger($1)", [t]);
    expect(data.transactions).toHaveLength(2);
  });

  it("the wallet's last-updated stamp moves when an entry through it is added or deleted", async () => {
    await db.query("update public.ledgers set last_activity_at = '2020-01-01' where id = $1", [wallet]);
    const e = await post({ ledger_id: party, direction: "in", amount: "100", wallet_ledger_id: wallet });
    expect(await activity(wallet)).not.toMatch(/^2020/);
    await db.query("update public.ledgers set last_activity_at = '2020-01-01' where id in ($1, $2)", [wallet, party]);
    await rpc(db, OWNER, "public.delete_transaction($1)", [e.id]);
    expect(await activity(wallet)).not.toMatch(/^2020/);
    expect(await activity(party)).not.toMatch(/^2020/);
  });
});
