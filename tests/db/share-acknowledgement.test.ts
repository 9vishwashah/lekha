import { beforeAll, describe, expect, it } from "vitest";
import { as, createDb, rpc, type Db } from "./harness";

const OWNER = "user_ack_owner";
const OTHER = "user_ack_other";
const j = (v: unknown) => JSON.stringify(v);
const token = (s: string) => (s + "y".repeat(48)).slice(0, 48);
let db: Db;
let ws: string;
let ledger: string;
const T = token("ackShare");

type Payload = { ledger: { last_activity_at: string }; acknowledgement: { at: string; name: string | null; current: boolean } | null };
const view = () => rpc<Payload>(db, null, "public.get_shared_ledger($1)", [T]);
const ack = (version: string, name: string | null = "Ramesh") =>
  rpc<{ current: boolean; name: string | null }>(db, null, "public.acknowledge_shared_ledger($1, $2::timestamptz, $3)", [T, version, name]);
const post = (amount: string) =>
  rpc(db, OWNER, "public.post_transaction($1::jsonb)", [j({ ledger_id: ledger, txn_date: "2026-11-01", kind: "regular", status: "posted", direction: "out", amount })]);

beforeAll(async () => {
  db = await createDb();
  ws = await rpc<string>(db, OWNER, "public.create_workspace($1, $2, $3)", ["Ack", "Owner", null]);
  ledger = await rpc<string>(db, OWNER, "public.create_ledger($1::jsonb)", [j({ workspace_id: ws, name: "Ramesh", ledger_type: "basic", opening_balance: "0" })]);
  await post("100");
  await rpc(db, OWNER, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledger, T, "c", "{}"]);
});

describe("confirming a shared statement", () => {
  it("starts unconfirmed", async () => {
    expect((await view()).acknowledgement).toBeNull();
  });

  it("the person it was shared with confirms the version they saw", async () => {
    const v = await view();
    const r = await ack(v.ledger.last_activity_at);
    expect(r).toMatchObject({ current: true, name: "Ramesh" });
    expect((await view()).acknowledgement).toMatchObject({ current: true, name: "Ramesh" });
  });

  it("confirming twice for the same version records it once", async () => {
    const v = await view();
    await ack(v.ledger.last_activity_at);
    const rows = await as(db, OWNER, (q) => q("select id from public.share_acknowledgements where ledger_id = $1", [ledger]));
    expect(rows).toHaveLength(1);
  });

  it("resets when the ledger changes, and needs a new confirmation", async () => {
    const before = await view();
    await post("50");
    const after = await view();
    expect(after.ledger.last_activity_at).not.toBe(before.ledger.last_activity_at);
    expect(after.acknowledgement).toMatchObject({ current: false });
    // Confirming the old version is refused: they must look at the new entries first.
    await expect(ack(before.ledger.last_activity_at)).rejects.toThrow(/changed since you opened it/);
    expect((await ack(after.ledger.last_activity_at)).current).toBe(true);
  });

  it("the owner can read confirmations, other people cannot, and nobody writes them directly", async () => {
    expect(await as(db, OWNER, (q) => q("select id from public.share_acknowledgements where ledger_id = $1", [ledger]))).toHaveLength(2);
    expect(await as(db, OTHER, (q) => q("select id from public.share_acknowledgements where ledger_id = $1", [ledger]))).toHaveLength(0);
    await expect(
      as(db, OWNER, (q) => q("insert into public.share_acknowledgements (workspace_id, ledger_id, share_link_id, ledger_version) select workspace_id, ledger_id, id, now() from public.share_links where ledger_id = $1", [ledger])),
    ).rejects.toThrow();
  });

  it("a revoked link cannot confirm", async () => {
    const v = await view();
    await rpc(db, OWNER, "public.create_share_link($1, $2, $3, $4::jsonb)", [ledger, token("rotated"), "c", "{}"]);
    await expect(ack(v.ledger.last_activity_at)).rejects.toThrow(/no longer active/);
  });
});
